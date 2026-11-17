"""Run selected single-threaded asyncio tests without a Windows wakeup socket.

This is a test harness only: no sockets, subprocess protocols, cross-thread
callbacks or production event-loop behavior are claimed by these tests.
"""
import asyncio
import selectors
import sys
import threading
import time

import pytest


class TimerSelector(selectors.SelectSelector):
    def select(self, timeout=None):
        assert not self.get_map(), 'network or pipe I/O is outside this harness'
        assert timeout is not None, 'unbounded wait is outside this harness'
        if timeout > 0:
            time.sleep(timeout)
        return []


class TimerLoop(asyncio.SelectorEventLoop):
    def __init__(self):
        self.creator = threading.get_ident()
        super().__init__(TimerSelector())

    def _make_self_pipe(self):
        pass

    def _close_self_pipe(self):
        pass

    def _write_to_self(self):
        assert threading.get_ident() == self.creator, 'cross-thread callback is outside this harness'


class TimerPolicy(asyncio.DefaultEventLoopPolicy):
    _loop_factory = TimerLoop


if __name__ == '__main__':
    from pathlib import Path
    sys.path.insert(0, str(Path.cwd()))
    asyncio.set_event_loop_policy(TimerPolicy())
    raise SystemExit(pytest.main(sys.argv[1:]))
