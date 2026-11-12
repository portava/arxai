#ifndef ARX_ECONOMIC_CALENDAR_MQH
#define ARX_ECONOMIC_CALENDAR_MQH
// Read-only economic-calendar collector. No trade library, command polling,
// execution gates or account mutations. Called by the existing OnTimer.
// The caller supplies its existing transport (WebRequest or credential-free
// ArxLocalRequest). The server verifies broker timezone and terminal UTC clock.
#ifndef ARX_CALENDAR_REQUEST
#define ARX_CALENDAR_REQUEST WebRequest
#endif
void ArxCalendarNoopBeforeSend() {}
#ifndef ARX_CALENDAR_BEFORE_SEND
#define ARX_CALENDAR_BEFORE_SEND ArxCalendarNoopBeforeSend
#endif
ulong arxCalendarLastAttempt = 0;
string ArxCalendarQuote(string value)
{
   StringReplace(value,"\\","\\\\"); StringReplace(value,"\"","\\\"");
   StringReplace(value,"\r","\\r"); StringReplace(value,"\n","\\n"); StringReplace(value,"\t","\\t");
   return "\""+value+"\"";
}
string ArxCalendarRaw(long value)
{
   if(value == LONG_MIN) return "null";
   // Raw integer-as-string avoids JavaScript long precision loss. The receiver
   // divides by one million once, preserving zero and provider units/multipliers.
   return ArxCalendarQuote((string)value);
}
void ArxPushEconomicCalendar(const string baseUrl, const string token)
{
   ulong monotonic = GetTickCount64();
   if(arxCalendarLastAttempt != 0 && monotonic-arxCalendarLastAttempt < 60000) return;
   arxCalendarLastAttempt = monotonic;
   bool connected = (bool)TerminalInfoInteger(TERMINAL_CONNECTED);
   bool tester = (bool)MQLInfoInteger(MQL_TESTER);
   datetime utc = TimeGMT(), server = TimeTradeServer(), quote = TimeCurrent();
   datetime from = server-86400, to = server+14*86400;
   int count = -1, error = 0, omitted = 0;
   MqlCalendarValue values[];
   if(connected && !tester) {
      ResetLastError(); count = CalendarValueHistory(values,from,to); error = GetLastError();
      if(count < 0 && error == 0) error = 5401;
   }
   string rows = "";
   if(count >= 0 && error == 0) {
      for(int i=0;i<count;i++) {
         if(i >= 2000) { omitted++; continue; }
         MqlCalendarEvent event; MqlCalendarCountry country;
         if(!CalendarEventById(values[i].event_id,event) || !CalendarCountryById(event.country_id,country)) { omitted++; continue; }
         if(rows != "") rows += ",";
         rows += "{\"id\":"+ArxCalendarQuote((string)values[i].id)+",\"eventId\":"+ArxCalendarQuote((string)values[i].event_id);
         rows += ",\"timeServer\":"+(string)(long)values[i].time+",\"timeMode\":"+ArxCalendarQuote(EnumToString(event.time_mode));
         rows += ",\"title\":"+ArxCalendarQuote(event.name)+",\"country\":"+ArxCalendarQuote(country.name)+",\"currency\":"+ArxCalendarQuote(country.currency);
         rows += ",\"importance\":"+(string)(int)event.importance+",\"actual\":"+ArxCalendarRaw(values[i].actual_value);
         rows += ",\"forecast\":"+ArxCalendarRaw(values[i].forecast_value)+",\"previous\":"+ArxCalendarRaw(values[i].prev_value)+",\"revised\":"+ArxCalendarRaw(values[i].revised_prev_value);
         rows += ",\"unit\":"+ArxCalendarQuote(EnumToString(event.unit))+",\"multiplier\":"+ArxCalendarQuote(EnumToString(event.multiplier))+"}";
      }
   }
   // Sample clocks again after the potentially slow provider call, so transport
   // delay does not silently turn initial query time into a fresh observation.
   utc=TimeGMT(); server=TimeTradeServer(); quote=TimeCurrent();
   string body = "{\"version\":1,\"account\":"+ArxCalendarQuote((string)AccountInfoInteger(ACCOUNT_LOGIN))+",\"server\":"+ArxCalendarQuote(AccountInfoString(ACCOUNT_SERVER));
   body += ",\"terminalConnected\":"+(connected ? "true" : "false")+",\"tester\":"+(tester ? "true" : "false");
   body += ",\"collectedAtUtc\":"+(string)(long)utc+",\"serverNow\":"+(string)(long)server+",\"lastQuoteServer\":"+(string)(long)quote;
   body += ",\"windowFromServer\":"+(string)(long)from+",\"windowToServer\":"+(string)(long)to;
   body += ",\"status\":"+ArxCalendarQuote(count>=0 && error==0 ? "ok" : "error")+",\"errorCode\":"+(string)error+",\"omitted\":"+(string)omitted+",\"events\":["+rows+"]}";
   char post[], result[]; string responseHeaders;
   int length=StringToCharArray(body,post,0,WHOLE_ARRAY,CP_UTF8); if(length>0) ArrayResize(post,length-1);
   string headers="Content-Type: application/json\r\nX-MT5-Bridge-Token: "+token+"\r\n";
   // Refresh the caller's read-only safety proof after slow provider reads.
   ARX_CALENDAR_BEFORE_SEND();
   int code=ARX_CALENDAR_REQUEST("POST",baseUrl+"/api/mt5/calendar/ingest",headers,10000,post,result,responseHeaders);
   // HTTP 200 acknowledges receipt only. Provider readiness is decided by the
   // server's accepted field and never fabricated from a successful transport.
   if(code != 200) PrintFormat("ARX economic-calendar telemetry HTTP %d",code);
}
#endif
