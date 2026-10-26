// DEMO execution core. Included verbatim by the EA and the offline C++ harness.
// CTrade::PositionClosePartial is ticket-scoped and hedging-only. Netting is
// refused before entry: an opposite netting deal can reverse a changed position.
// https://www.mql5.com/en/docs/standardlibrary/tradeclasses/ctrade/ctradepositionclosepartial
#ifndef ARX_DEMO_EXECUTION_MQH
#define ARX_DEMO_EXECUTION_MQH

struct ArxDemoOutcome
{
   string status;
   string reason;
   ulong ticket;
   double price;
   double volume;
   uint retcode;
};

bool DemoVolumeValid(const double volume, const double minimum,
                     const double step, const double maximum)
{
   if(!MathIsValidNumber(volume) || !MathIsValidNumber(minimum) ||
      !MathIsValidNumber(step) || !MathIsValidNumber(maximum) ||
      minimum <= 0 || step <= 0 || maximum < minimum) return false;
   if(volume < minimum - 1e-9 || volume > maximum + 1e-9) return false;
   return MathAbs(volume - MathRound(volume / step) * step) <= 1e-9;
}

string DemoGuardReason()
{
   if(!EnableDemoExecution) return "REJECTED_DEMO_EXECUTION_DISABLED_INPUT";
   if(ReadOnlyMode) return "REJECTED_READ_ONLY_MODE_ACTIVE";
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) != ACCOUNT_TRADE_MODE_DEMO)
      return "REJECTED_NOT_DEMO_ACCOUNT";
   if(AccountInfoInteger(ACCOUNT_MARGIN_MODE) != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
      return "REJECTED_DEMO_HEDGING_ACCOUNT_REQUIRED";
   if(!TerminalInfoInteger(TERMINAL_CONNECTED) || !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ||
      !MQLInfoInteger(MQL_TRADE_ALLOWED) || !AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) ||
      !AccountInfoInteger(ACCOUNT_TRADE_EXPERT)) return "REJECTED_TERMINAL_TRADING_NOT_ALLOWED";
   return "";
}

void ExecuteDemoCommand(const string kind, const string symbol, const string side,
                        const ulong ticket, const double volume, const double sl,
                        const double tp, ArxDemoOutcome &out)
{
   out.status = "REJECTED"; out.reason = DemoGuardReason();
   out.ticket = 0; out.price = 0; out.volume = 0; out.retcode = 0;
   if(out.reason != "") return;
   out.reason = "REJECTED_UNKNOWN_COMMAND_TYPE";
   if(kind != "PLACE_MARKET_ORDER" && kind != "CLOSE_POSITION" && kind != "MODIFY_SLTP") return;
   if(g_maintenanceMode && kind == "PLACE_MARKET_ORDER")
   { out.reason = "REJECTED_MAINTENANCE_MODE"; return; }
   if(StringLen(symbol) == 0 || !SymbolSelect(symbol, true))
   { out.reason = "REJECTED_SYMBOL_UNRESOLVED"; return; }

   double minimum = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   double maximum = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   if(kind != "MODIFY_SLTP" && !DemoVolumeValid(volume, minimum, step, maximum))
   { out.reason = "REJECTED_INVALID_VOLUME_PAYLOAD"; return; }
   // Never round UP, clamp to a minimum, or silently substitute another volume.
   if(kind == "PLACE_MARKET_ORDER" && volume > DemoMaxLot)
   { out.reason = "REJECTED_LOT_EXCEEDS_CEILING"; return; }

   if(kind != "PLACE_MARKET_ORDER")
   {
      if(ticket == 0 || !PositionSelectByTicket(ticket))
      { out.reason = "REJECTED_POSITION_NOT_FOUND"; return; }
      if(PositionGetString(POSITION_SYMBOL) != symbol)
      { out.reason = "REJECTED_POSITION_SYMBOL_MISMATCH"; return; }
      if(kind == "CLOSE_POSITION")
      {
         double current = PositionGetDouble(POSITION_VOLUME);
         double remainder = current - volume;
         if(!MathIsValidNumber(current) || current <= 0 || remainder < -1e-9 ||
            (remainder > 1e-9 && !DemoVolumeValid(remainder, minimum, step, maximum)))
         { out.reason = "REJECTED_INVALID_CLOSE_REMAINDER"; return; }
      }
   }

   if(!MathIsValidNumber(sl) || !MathIsValidNumber(tp) || sl < 0 || tp < 0)
   { out.reason = "REJECTED_INVALID_STOPS"; return; }
   if(kind == "PLACE_MARKET_ORDER")
   {
      if(side != "buy" && side != "sell")
      { out.reason = "REJECTED_INVALID_SIDE"; return; }
      string guard = "";
      if(!PreTradeBrokerGuard(symbol, side == "buy" ? "BUY" : "SELL", volume,
                             sl, tp, DemoMaxLot, 0.0, guard))
      { out.reason = guard; return; }
   }
   g_demoTrade.SetAsyncMode(false);
   g_demoTrade.SetDeviationInPoints(g_maxDeviationPoints);
   if(!g_demoTrade.SetTypeFillingBySymbol(symbol))
   { out.reason = "REJECTED_UNSUPPORTED_FILLING_MODE"; return; }
   bool sent = false;
   if(kind == "PLACE_MARKET_ORDER")
      sent = g_demoTrade.PositionOpen(symbol, side == "sell" ? ORDER_TYPE_SELL : ORDER_TYPE_BUY,
                                     volume, 0.0, sl, tp, "ARX_DEMO");
   else if(kind == "CLOSE_POSITION")
      // Use the bounded volume for BOTH partial and full closes. PositionClose
      // would read the current position again and could close a larger size.
      sent = g_demoTrade.PositionClosePartial(ticket, volume, g_maxDeviationPoints);
   else
      sent = g_demoTrade.PositionModify(ticket, sl, tp);

   out.retcode = g_demoTrade.ResultRetcode();
   // A CTrade bool only proves request validation. It does not prove a fill.
   // Any nonfinal outcome remains FAILED/uncertain and MUST NOT be retried.
   out.status = "FAILED"; out.reason = "BROKER_OUTCOME_UNCONFIRMED_DO_NOT_RETRY";
   if(kind == "MODIFY_SLTP")
   {
      if(!sent || (out.retcode != TRADE_RETCODE_DONE && out.retcode != TRADE_RETCODE_NO_CHANGES)) return;
      double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
      if(point <= 0 || !PositionSelectByTicket(ticket) ||
         MathAbs(PositionGetDouble(POSITION_SL) - sl) > point * 0.5 ||
         MathAbs(PositionGetDouble(POSITION_TP) - tp) > point * 0.5) return;
      out.ticket = ticket;
   }
   else
   {
      if(!sent || (out.retcode != TRADE_RETCODE_DONE && out.retcode != TRADE_RETCODE_DONE_PARTIAL)) return;
      // Record the broker's values, never the requested lot or a quote fallback.
      out.price = g_demoTrade.ResultPrice(); out.volume = g_demoTrade.ResultVolume();
      if(!MathIsValidNumber(out.price) || out.price <= 0 ||
         !MathIsValidNumber(out.volume) || out.volume <= 0 || out.volume > volume + 1e-9) return;
      if(kind == "CLOSE_POSITION") out.ticket = ticket;
      else
      {
         // An order/deal ID is not necessarily the position ticket. Resolve the
         // actual position through the broker's deal position identifier.
         ulong deal = g_demoTrade.ResultDeal();
         if(deal == 0 || !HistoryDealSelect(deal)) return;
         long identifier = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
         for(int i = 0; i < PositionsTotal(); i++)
         {
            ulong candidate = PositionGetTicket(i);
            if(candidate > 0 && identifier > 0 && PositionGetInteger(POSITION_IDENTIFIER) == identifier &&
               PositionGetString(POSITION_SYMBOL) == symbol) { out.ticket = candidate; break; }
         }
         if(out.ticket == 0) return;
      }
   }
   out.status = "FILLED_DEMO"; out.reason = "OK";
}

// Durable intent + result journal. One exclusive common-file handle is held
// through execution and write-back. Never erase these files to retry a command.
// A crash after intent but before a complete result is uncertain, not retryable.
int g_demoJournal = INVALID_HANDLE;

int BeginDemoCommand(const string commandId)
{
   string key = Sha256Hex(AccountInfoString(ACCOUNT_SERVER) + "|" +
                         IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "|" + commandId);
   if(StringLen(key) != 64) return 0;
   g_demoJournal = FileOpen("ARX_DEMO_131\\" + key + ".txt",
                           FILE_READ | FILE_WRITE | FILE_TXT | FILE_UNICODE | FILE_COMMON);
   if(g_demoJournal == INVALID_HANDLE) return 0; // busy/unwritable: no broker call
   if(FileSize(g_demoJournal) > 0)
   {
      string intent = FileReadString(g_demoJournal);
      string body = FileReadString(g_demoJournal);
      string digest = FileReadString(g_demoJournal);
      string commit = FileReadString(g_demoJournal);
      FileClose(g_demoJournal); g_demoJournal = INVALID_HANDLE;
      if(intent == "PENDING" && commit == "COMMIT" && StringLen(digest) == 64 && Sha256Hex(body) == digest)
      {
         string response;
         HttpPost("/api/mt5/demo-command-result", body, response, "DEMO_REPLAY");
      }
      else
         WriteBackDemoResult(commandId, "FAILED", "PRIOR_ATTEMPT_UNCERTAIN_DO_NOT_RETRY", 0, 0, 0);
      return 0;
   }
   ResetLastError();
   uint written = FileWriteString(g_demoJournal, "PENDING\r\n");
   FileFlush(g_demoJournal);
   if(written == 0 || GetLastError() != 0)
   { FileClose(g_demoJournal); g_demoJournal = INVALID_HANDLE; return 0; }
   return 1;
}

void PersistDemoResult(const string body)
{
   if(g_demoJournal == INVALID_HANDLE) return;
   // Append; the durable PENDING record is never overwritten. Hash + commit
   // protect against a truncated result. Failure leaves a nonretryable intent.
   FileWriteString(g_demoJournal, body + "\r\n" + Sha256Hex(body) + "\r\nCOMMIT\r\n");
   FileFlush(g_demoJournal);
   FileClose(g_demoJournal); g_demoJournal = INVALID_HANDLE;
}
#endif
