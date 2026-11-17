"""Adapter for the optional Feishu SDK 1.8.0 WebSocket client."""
import asyncio
import base64
import http
import importlib
import logging
from concurrent.futures import TimeoutError
from importlib.metadata import version
from time import monotonic

log = logging.getLogger(__name__)


def card_client_class(ws):
    class CardClient(ws.Client):
        async def _connect(self):
            await super()._connect()
            self.ready.set()

        async def _disconnect(self):
            self.ready.clear()
            await super()._disconnect()

        async def _handle_data_frame(self, frame):
            headers = frame.headers
            if ws._get_by_key(headers, ws.HEADER_TYPE) != ws.MessageType.CARD.value:
                return await super()._handle_data_frame(frame)
            # SDK 1.8.0 returns early on CARD. Dispatch with the same response
            # envelope and retain the original frame type for acknowledgment.
            payload = frame.payload
            parts = int(ws._get_by_key(headers, ws.HEADER_SUM))
            if parts > 1:
                payload = self._combine(ws._get_by_key(headers, ws.HEADER_MESSAGE_ID), parts,
                                        int(ws._get_by_key(headers, ws.HEADER_SEQ)), payload)
                if payload is None:
                    return
            start = monotonic()
            response = ws.Response(code=http.HTTPStatus.OK)
            try:
                result = self._event_handler._do_without_validation(payload)
                if result is not None:
                    response.data = base64.b64encode(ws.JSON.marshal(result).encode('utf-8'))
            except Exception:
                response = ws.Response(code=http.HTTPStatus.INTERNAL_SERVER_ERROR)
            header = headers.add()
            header.key = ws.HEADER_BIZ_RT
            header.value = str(int((monotonic() - start) * 1000))
            frame.payload = ws.JSON.marshal(response).encode('utf-8')
            await self._write_message(frame.SerializeToString())

    return CardClient


def listen(config, app_loop, receive, ready, stopping):
    if version('lark-oapi') != '1.8.0':
        raise RuntimeError('Install requirements-feishu.txt to enable card decisions')
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    import lark_oapi as lark
    from lark_oapi.event.callback.model.p2_card_action_trigger import P2CardActionTriggerResponse

    ws = importlib.import_module('lark_oapi.ws.client')
    ws.loop = loop

    class RedactFeishuLogs(logging.Filter):
        def filter(self, record):
            if record.levelno >= logging.WARNING:
                record.msg, record.args = 'Feishu SDK transport reported an error', ()
                record.exc_info = None
                record.stack_info = None
                return True
            return False

    sdk_log = logging.getLogger('Lark')
    redaction = RedactFeishuLogs()
    sdk_log.addFilter(redaction)

    def callback(data):
        try:
            args = (data.header.app_id, data.event.operator.open_id, data.event.context.open_message_id,
                    data.event.action.value)
        except AttributeError:
            args = None
        kind, text = 'error', '无法验证此审批操作。'
        if args and not stopping.is_set() and not app_loop.is_closed():
            future = asyncio.run_coroutine_threadsafe(receive(*args), app_loop)
            try:
                kind, text = future.result(timeout=1.5)
            except TimeoutError:
                future.cancel()
                text = '暂未确认提交，请稍后检查卡片状态。'
            except Exception:
                text = '无法提交审批，请稍后重试。'
        return P2CardActionTriggerResponse({'toast': {'type': kind, 'content': text}})

    handler = (lark.EventDispatcherHandler.builder('', '')
               .register_p2_card_action_trigger(callback).build())
    client = card_client_class(ws)(config.app_id, config.secret, event_handler=handler,
                                  log_level=lark.LogLevel.WARNING)
    client.ready = ready

    async def serve():
        while not stopping.is_set():
            try:
                await client._connect()
                logging.getLogger('uvicorn.error').info('Feishu card listener connected')
                break
            except Exception as exc:
                code = getattr(exc, 'code', None)
                log.warning('Feishu card connection failed: %s code=%s',
                            type(exc).__name__, code if type(code) is int else 'unknown')
                for _ in range(20):
                    if stopping.is_set():
                        return
                    await asyncio.sleep(1)
        if stopping.is_set():
            return
        asyncio.create_task(client._ping_loop())
        while not stopping.is_set():
            await asyncio.sleep(.25)

    try:
        loop.run_until_complete(serve())
    finally:
        ready.clear()
        tasks = asyncio.all_tasks(loop)
        for task in tasks:
            task.cancel()
        if tasks:
            loop.run_until_complete(asyncio.gather(*tasks, return_exceptions=True))
        loop.run_until_complete(client._disconnect())
        loop.close()
        sdk_log.removeFilter(redaction)
