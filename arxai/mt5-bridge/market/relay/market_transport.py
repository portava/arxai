"""Local-only auth and file primitives for the isolated market relay."""

from pathlib import Path

import datetime,os,stat,urllib.request

from market_observation_contract import ContractError

TERMINAL = Path('/Users/areyouok/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5')

PRESET = TERMINAL/'MQL5/Presets/ARX_62249354_ReadOnly.set'

BASE_URL = 'http://127.0.0.1:18765'

MAX_BYTES = 2*1024*1024

PRESET_ARMS = ('AllowOrderExecution','AllowPendingOrders','AllowProtectionModify','AllowPositionClose','AllowPendingCancel','AllowPendingModify','AllowEmergencyClose')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None

def now_iso(): return datetime.datetime.now(datetime.timezone.utc).isoformat()

def load_token(preset=PRESET):
    if preset.is_symlink(): raise ContractError('UNSAFE_PRESET_FILE')
    fd=os.open(preset,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        metadata=os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid!=os.getuid() or metadata.st_mode & 0o077:
            raise ContractError('UNSAFE_PRESET_PERMISSIONS')
        if metadata.st_size>65536: raise ContractError('UNSAFE_PRESET_SIZE')
        text=os.read(fd,65537).decode('utf-16')
    finally: os.close(fd)
    config=dict(line.split('=',1) for line in text.splitlines() if '=' in line)
    if (config.get('BridgeBaseUrl')!=BASE_URL or config.get('ReadOnlyMode')!='true'
        or any(config.get(key)!='false' for key in PRESET_ARMS)):
        raise ContractError('PRESET_READ_ONLY_ASSERTION_FAILED')
    token=config.get('BridgeToken')
    if not token or '\r' in token or '\n' in token: raise ContractError('INVALID_EXISTING_BRIDGE_TOKEN')
    return token

def atomic_write(path,data):
    temporary=path.with_name(path.name+'.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'wb') as output: output.write(data)
    temporary.replace(path)

def read_regular(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        metadata=os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size>MAX_BYTES: raise ContractError('UNSAFE_REQUEST_FILE')
        return os.read(fd,MAX_BYTES+1)
    finally: os.close(fd)
