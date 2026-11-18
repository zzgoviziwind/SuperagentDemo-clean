import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface OwnedProcess {
  /** On Windows this is the supervisor. Use pid to identify the protocol peer. */
  child: ChildProcessWithoutNullStreams;
  pid: number;
  /** Requests tree termination. Observe child.close for completion. */
  terminate(): void;
}

export function spawnOwned(
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<OwnedProcess>;
