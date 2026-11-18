using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

internal static class Installer
{
    private static int Main(string[] args)
    {
        // The system compiler can target legacy .NET I/O defaults. Opt this
        // process into modern normalization and use the extended path syntax
        // for extraction without relying on machine-wide long path policy.
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        string scratch = null;
        string extractionPath = null;
        bool created = false;
        try
        {
            scratch = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "sa-" + Guid.NewGuid().ToString("N")));
            extractionPath = ExtendedPath(scratch);
            Directory.CreateDirectory(extractionPath);
            created = true;
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("SuperAgent.Package"))
            {
                if (payload == null) throw new InvalidDataException("The offline installer payload is missing.");
                using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
                {
                    archive.ExtractToDirectory(extractionPath);
                }
            }

            var command = new StringBuilder("-NoProfile -ExecutionPolicy Bypass -File ");
            command.Append(Quote(Path.Combine(scratch, "SuperAgent.ps1"))).Append(" -Action Install");
            foreach (string argument in args) command.Append(' ').Append(Quote(argument));
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
                Arguments = command.ToString(),
                UseShellExecute = false
            };
            using (Process process = Process.Start(start))
            {
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("SuperAgent setup: " + error.Message);
            return 1;
        }
        finally
        {
            if (created)
            {
                try { Directory.Delete(extractionPath, true); }
                catch (IOException) { Console.Error.WriteLine("Setup files remain at " + scratch); }
                catch (UnauthorizedAccessException) { Console.Error.WriteLine("Setup files remain at " + scratch); }
            }
        }
    }

    private static string ExtendedPath(string path)
    {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        return path.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + path.Substring(2) : @"\\?\" + path;
    }

    private static string Quote(string argument)
    {
        // Windows argv escaping: backslashes directly before quotes need doubling.
        var result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"') result.Append('\\', backslashes + 1);
            result.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        return result.Append('\\', backslashes * 2).Append('"').ToString();
    }
}
