/* Windows 10+ supervisor. No job or control handle ever enters the target. */
#define _WIN32_WINNT 0x0a00
#include <windows.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)
#endif

/* The CRT obtains fd 4 from libuv's STARTUPINFO descriptor table. Node
   requests ordinary pipes (not "overlapped") on the child end. Any control
   data, EOF or read error ends ownership. The thread handle is waitable. */
static DWORD WINAPI watch_owner(void *control) {
    BYTE byte;
    DWORD count;
    ReadFile((HANDLE)control, &byte, 1, &count, NULL);
    return 0;
}

static BOOL send_status(HANDLE control, const char *kind, const char *stage, DWORD value) {
    char buffer[96];
    DWORD written = 0;
    int length = stage ? snprintf(buffer, sizeof(buffer), "%s %s %lu\n", kind, stage, (unsigned long)value)
                       : snprintf(buffer, sizeof(buffer), "%s %lu\n", kind, (unsigned long)value);
    return length > 0 && (size_t)length < sizeof(buffer)
        && WriteFile(control, buffer, (DWORD)length, &written, NULL) && written == (DWORD)length;
}

/* Node already quoted the target command line for CreateProcessW. Remove
   only our own executable token, preserving empty arguments, quotes and slashes. */
static wchar_t *target_command_line(void) {
    const wchar_t *p = GetCommandLineW();
    BOOL quoted = FALSE;
    while (*p && (quoted || (*p != L' ' && *p != L'\t'))) {
        if (*p == L'"') quoted = !quoted;
        ++p;
    }
    while (*p == L' ' || *p == L'\t') ++p;
    return _wcsdup(p);
}

static BOOL stop_and_drain(HANDLE job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state;
    if (!TerminateJobObject(job, 1)) return FALSE;
    /* Termination is asynchronous. Publish normal supervisor exit only
       after the kernel reports no active processes in our Job. */
    for (;;) {
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &state, sizeof(state), NULL))
            return FALSE;
        if (state.ActiveProcesses == 0) return TRUE;
        Sleep(5);
    }
}

int wmain(int argc, wchar_t **argv) {
    HANDLE ready = (HANDLE)_get_osfhandle(3);
    HANDLE control = (HANDLE)_get_osfhandle(4);
    if (argc < 2 || GetFileType(ready) != FILE_TYPE_PIPE || GetFileType(control) != FILE_TYPE_PIPE)
        return 125;

    STARTUPINFOEXW start = {0};
    PROCESS_INFORMATION target = {0};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    HANDLE stdio[3] = {0};
    HANDLE job = NULL, watcher = NULL;
    BOOL attributes_ready = FALSE, announced = FALSE;
    DWORD code = 125, error = 0;
    const char *stage = "control";
    wchar_t *command = NULL;
    SIZE_T bytes = 0;

    if (!SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0)
        || !SetHandleInformation(ready, HANDLE_FLAG_INHERIT, 0)) goto failed;
    watcher = CreateThread(NULL, 0, watch_owner, control, 0, NULL);
    if (!watcher) goto failed;
    stage = "create_job";
    job = CreateJobObjectW(NULL, NULL); /* Unnamed, non-inheritable, single owner. */
    if (!job) goto failed;
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    stage = "job_limits";
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
        goto failed;

    stage = "stdio";
    const DWORD standard_ids[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
    for (int i = 0; i < 3; ++i) {
        if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(standard_ids[i]), GetCurrentProcess(),
                             &stdio[i], 0, TRUE, DUPLICATE_SAME_ACCESS))
            goto failed;
    }
    start.StartupInfo.cb = sizeof(start);
    start.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    start.StartupInfo.hStdInput = stdio[0];
    start.StartupInfo.hStdOutput = stdio[1];
    start.StartupInfo.hStdError = stdio[2];

    stage = "attribute_list";
    InitializeProcThreadAttributeList(NULL, 2, 0, &bytes);
    if (!bytes) goto failed;
    start.lpAttributeList = HeapAlloc(GetProcessHeap(), 0, bytes);
    if (!start.lpAttributeList) { SetLastError(ERROR_OUTOFMEMORY); goto failed; }
    if (!InitializeProcThreadAttributeList(start.lpAttributeList, 2, 0, &bytes)) goto failed;
    attributes_ready = TRUE;
    if (!UpdateProcThreadAttribute(start.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                   stdio, sizeof(stdio), NULL, NULL)) goto failed;
    /* Atomic membership also covers supervisor death between CreateProcess
       and a separate AssignProcessToJobObject. Never fall back to unowned spawn. */
    stage = "job_attribute";
    if (!UpdateProcThreadAttribute(start.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                   &job, sizeof(job), NULL, NULL)) goto failed;
    command = target_command_line();
    if (!command) { SetLastError(ERROR_OUTOFMEMORY); goto failed; }
    stage = "suspended_launch";
    if (!CreateProcessW(argv[1], command, NULL, NULL, TRUE,
                        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
                        NULL, NULL, &start.StartupInfo, &target)) goto failed;
    BOOL member = FALSE;
    stage = "job_membership";
    if (!IsProcessInJob(target.hProcess, job, &member) || !member) goto failed;
    stage = "owner_lost";
    if (WaitForSingleObject(watcher, 0) != WAIT_TIMEOUT) goto failed;
    stage = "resume";
    if (ResumeThread(target.hThread) != 1) goto failed;
    stage = "readiness";
    if (!send_status(ready, "READY", NULL, target.dwProcessId)) goto failed;
    announced = TRUE;

    HANDLE wait_for[] = {target.hProcess, watcher};
    DWORD reason = WaitForMultipleObjects(2, wait_for, FALSE, INFINITE);
    if (reason == WAIT_OBJECT_0) {
        stage = "root_status";
        if (!GetExitCodeProcess(target.hProcess, &code)) goto failed;
    } else if (reason == WAIT_OBJECT_0 + 1) {
        code = 1;
    } else {
        stage = "wait";
        goto failed;
    }
    goto cleanup;

failed:
    error = GetLastError();
    code = 125;
cleanup:
    if (target.hProcess) {
        /* Also dispose of a suspended root on any unexpected membership error. */
        if (!announced) TerminateProcess(target.hProcess, 1);
        if (!stop_and_drain(job)) code = 125;
        CloseHandle(target.hThread);
        CloseHandle(target.hProcess);
    }
    if (job) CloseHandle(job); /* kill-on-close covers supervisor crash at any instruction */
    if (!announced) send_status(ready, "ERROR", stage, error);
    if (attributes_ready) DeleteProcThreadAttributeList(start.lpAttributeList);
    if (start.lpAttributeList) HeapFree(GetProcessHeap(), 0, start.lpAttributeList);
    for (int i = 0; i < 3; ++i) if (stdio[i]) CloseHandle(stdio[i]);
    if (watcher) CloseHandle(watcher);
    free(command);
    /* A blocked control reader lives only until this supervisor process exits. */
    ExitProcess(code);
}
