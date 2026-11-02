import {expect,it} from 'vitest';
import {formatReportedPositionPnl} from './reportedPositionPnl';
it.each([[null,'—'],[undefined,'—'],[NaN,'—'],[Infinity,'—'],[-Infinity,'—'],[0,'+0'],[-0,'+0'],[-12.345,'-12.345'],[1234567890.12345,'+1234567890.12345'],[1e-9,'+1e-9']])('preserves reported numeric value %s', (input,expected)=>{expect(formatReportedPositionPnl(input)).toBe(expected);});
it('does not coerce strings or booleans into monetary values',()=>{expect(formatReportedPositionPnl('0' as never)).toBe('—');expect(formatReportedPositionPnl(false as never)).toBe('—');});
