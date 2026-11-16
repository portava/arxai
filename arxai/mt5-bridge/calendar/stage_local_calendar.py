"""Stage (never install/restart) the existing read-only Mac transport + calendar.
Usage: python3 stage_local_calendar.py EA_SOURCE RELAY_SOURCE OUTPUT_DIRECTORY
No presets, tokens, terminal settings or process state are read/changed.
"""
from pathlib import Path
import sys

def stage(ea_path, relay_path, output):
    ea = Path(ea_path).read_text()
    relay = Path(relay_path).read_text()
    for flag in ['ReadOnlyMode', 'AllowOrderExecution', 'AllowPendingOrders', 'AllowProtectionModify', 'AllowPositionClose', 'AllowPendingCancel', 'AllowPendingModify', 'AllowEmergencyClose']:
        import re
        expected = 'true' if flag == 'ReadOnlyMode' else 'false'
        assert re.search(r'const bool\s+'+flag+r'\s*=\s*'+expected+r'\s*;', ea), flag
    assert ea.count('PollAndExecute();') == 0
    assert 'AccountInfoInteger(ACCOUNT_LOGIN) != 62249354' in ea
    anchor = '   datetime now = TimeLocal();'
    assert ea.count(anchor) == 1
    ea = ea.replace(anchor, '   ArxPushEconomicCalendar(BridgeBaseUrl, BridgeToken);\n'+anchor)
    anchor = 'path != "/api/bridge/v2/ingest") return -1;'
    assert ea.count(anchor) == 1
    ea = ea.replace(anchor, 'path != "/api/bridge/v2/ingest" && path != "/api/mt5/calendar/ingest") return -1;')
    ea += '\n#define ARX_CALENDAR_REQUEST ArxLocalRequest\n#include "ArxEconomicCalendar.mqh"\n'
    anchor = "'/api/bridge/v2/ingest'])"
    assert relay.count(anchor) == 1
    relay = relay.replace(anchor,"'/api/bridge/v2/ingest', '/api/mt5/calendar/ingest'])")
    anchor = '    return path, body\n'
    assert relay.count(anchor) == 1
    relay = relay.replace(anchor, '''    if path == '/api/mt5/calendar/ingest':
        if (payload.get('version') != 1 or str(payload.get('account')) != '62249354'
                or payload.get('server') != 'DerivSVG-Server' or payload.get('tester') is not False):
            raise ValueError('calendar account or live-terminal assertion failed')
    return path, body
''')
    dest = Path(output); dest.mkdir(parents=True, exist_ok=True)
    (dest/'ARX_ReadOnly_LocalTransport.mq5').write_text(ea)
    (dest/'relay.py').write_text(relay)
    (dest/'ArxEconomicCalendar.mqh').write_text(Path(__file__).with_name('ArxEconomicCalendar.mqh').read_text())
    # Caller can compile these files in an isolated folder with existing includes.
    print('Staged read-only calendar telemetry; active EA and relay unchanged.')
if __name__ == '__main__': stage(*sys.argv[1:])
