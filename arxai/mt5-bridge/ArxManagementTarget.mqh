// Current-terminal preflight for SERVER-CREATED managementTargetV1 only.
// This is not signature verification, a terminal-session lock, or fill proof.
// MQL/C++ common subset: the offline harness compiles this exact source.
#ifndef ARX_MANAGEMENT_TARGET_MQH
#define ARX_MANAGEMENT_TARGET_MQH

void ArxJsonSpace(const string s, int &p)
{
   while(p < StringLen(s)) {
      ushort c=StringGetCharacter(s,p);
      if(c!=' ' && c!='\t' && c!='\r' && c!='\n') break;
      p++;
   }
}
bool ArxJsonString(const string s, int &p, string &out)
{
   out="";
   if(p>=StringLen(s) || StringGetCharacter(s,p++)!='"') return false;
   while(p<StringLen(s)) {
      ushort c=StringGetCharacter(s,p++);
      if(c=='"') return true;
      if(c<32) return false;
      if(c=='\\') {
         if(p>=StringLen(s)) return false;
         c=StringGetCharacter(s,p++);
         if(c=='u') {
            int code=0;
            for(int i=0;i<4;i++) {
               if(p>=StringLen(s)) return false;
               ushort h=StringGetCharacter(s,p++);
               int n=(h>='0' && h<='9')?h-'0':(h>='a' && h<='f')?h-'a'+10:(h>='A' && h<='F')?h-'A'+10:-1;
               if(n<0) return false;
               code=code*16+n;
            }
            // MQL strings are UTF-16; preserve escaped code units verbatim.
            c=(ushort)code;
         } else if(c=='n') c='\n';
         else if(c=='r') c='\r';
         else if(c=='t') c='\t';
         else if(c=='b') c=8;
         else if(c=='f') c=12;
         else if(c!='"' && c!='\\' && c!='/') return false;
      }
      out+=ShortToString(c);
   }
   return false;
}
bool ArxJsonValue(const string s, int &p, const int depth)
{
   if(depth>12) return false;
   ArxJsonSpace(s,p);
   if(p>=StringLen(s)) return false;
   ushort c=StringGetCharacter(s,p);
   if(c=='"') { string v; return ArxJsonString(s,p,v); }
   if(c=='{' || c=='[') {
      ushort end=(c=='{')?'}':']'; p++; ArxJsonSpace(s,p);
      if(p<StringLen(s) && StringGetCharacter(s,p)==end) { p++; return true; }
      while(p<StringLen(s)) {
         if(c=='{') {
            string key;
            if(!ArxJsonString(s,p,key)) return false;
            ArxJsonSpace(s,p);
            if(p>=StringLen(s) || StringGetCharacter(s,p++)!=':') return false;
         }
         if(!ArxJsonValue(s,p,depth+1)) return false;
         ArxJsonSpace(s,p);
         if(p>=StringLen(s)) return false;
         ushort sep=StringGetCharacter(s,p++);
         if(sep==end) return true;
         if(sep!=',') return false;
         ArxJsonSpace(s,p);
      }
      return false;
   }
   for(int k=0;k<3;k++) {
      string token=k==0?"null":k==1?"true":"false";
      if(StringSubstr(s,p,StringLen(token))==token) { p+=StringLen(token); return true; }
   }
   if(c=='-') p++;
   if(p>=StringLen(s)) return false;
   if(StringGetCharacter(s,p)=='0') p++;
   else {
      int start=p;
      while(p<StringLen(s) && StringGetCharacter(s,p)>='0' && StringGetCharacter(s,p)<='9') p++;
      if(start==p) return false;
   }
   if(p<StringLen(s) && StringGetCharacter(s,p)=='.') {
      int start=++p;
      while(p<StringLen(s) && StringGetCharacter(s,p)>='0' && StringGetCharacter(s,p)<='9') p++;
      if(start==p) return false;
   }
   if(p<StringLen(s) && (StringGetCharacter(s,p)=='e' || StringGetCharacter(s,p)=='E')) {
      p++;
      if(p<StringLen(s) && (StringGetCharacter(s,p)=='+' || StringGetCharacter(s,p)=='-')) p++;
      int start=p;
      while(p<StringLen(s) && StringGetCharacter(s,p)>='0' && StringGetCharacter(s,p)<='9') p++;
      if(start==p) return false;
   }
   return true;
}
// Direct members only. Duplicate requested keys, malformed/trailing JSON and
// oversized input fail closed. A nested text/key cannot impersonate a member.
bool ArxJsonMember(const string s, const string key, string &value, bool &found)
{
   found=false; value="";
   if(StringLen(s)>65536) return false;
   int p=0; bool closed=false; ArxJsonSpace(s,p);
   if(p>=StringLen(s) || StringGetCharacter(s,p++)!='{') return false;
   ArxJsonSpace(s,p);
   if(p<StringLen(s) && StringGetCharacter(s,p)=='}') { p++; closed=true; }
   else while(p<StringLen(s)) {
      string name;
      if(!ArxJsonString(s,p,name)) return false;
      ArxJsonSpace(s,p);
      if(p>=StringLen(s) || StringGetCharacter(s,p++)!=':') return false;
      ArxJsonSpace(s,p); int start=p;
      if(!ArxJsonValue(s,p,1)) return false;
      if(name==key) {
         if(found) return false;
         found=true; value=StringSubstr(s,start,p-start);
      }
      ArxJsonSpace(s,p);
      if(p>=StringLen(s)) return false;
      ushort sep=StringGetCharacter(s,p++);
      if(sep=='}') { closed=true; break; }
      if(sep!=',') return false;
      ArxJsonSpace(s,p);
   }
   ArxJsonSpace(s,p);
   return closed && p==StringLen(s);
}
bool ArxTargetString(const string object,const string key,string &value)
{
   string raw; bool found; int p=0;
   return ArxJsonMember(object,key,raw,found) && found && ArxJsonString(raw,p,value) && p==StringLen(raw) && StringLen(value)>0;
}
bool ArxTargetNumber(const string object,const string key,double &value,const bool nullable=false)
{
   string raw; bool found;
   if(!ArxJsonMember(object,key,raw,found) || !found || StringLen(raw)==0) return false;
   if(nullable && raw=="null") { value=0; return true; }
   ushort c=StringGetCharacter(raw,0);
   if(c!='-' && (c<'0' || c>'9')) return false;
   value=StringToDouble(raw);
   return MathIsValidNumber(value);
}
bool ArxPositiveDecimal(const string s)
{
   if(StringLen(s)==0 || StringLen(s)>19 || StringGetCharacter(s,0)=='0') return false;
   for(int i=0;i<StringLen(s);i++) if(StringGetCharacter(s,i)<'0' || StringGetCharacter(s,i)>'9') return false;
   if(StringLen(s)==19) {
      string maximum="9223372036854775807";
      for(int i=0;i<19;i++) {
         if(StringGetCharacter(s,i)<StringGetCharacter(maximum,i)) return true;
         if(StringGetCharacter(s,i)>StringGetCharacter(maximum,i)) return false;
      }
   }
   return true;
}
bool ArxSameValue(const double a,const double b)
{
   // Exact round-tripped doubles. Unknown/rounded historical snapshots hold;
   // do not widen a target using a price/volume-step tolerance.
   return MathIsValidNumber(a) && MathIsValidNumber(b) && a==b;
}

// Called immediately before CTrade, after all existing local arm checks.
// 'wire' is a command object, not the complete live-poll response envelope.
bool ArxManagementPreflight(const string wire,const string action,const ulong ticket,
                            const double sl,const double tp,bool &bound,string &reason)
{
   bound=false; reason="MANAGEMENT_TARGET_MALFORMED";
   string payload,target,raw; bool found;
   if(!ArxJsonMember(wire,"payload",payload,found)) return false;
   if(!found || payload=="null") return true; // ordinary manual command
   if(!ArxJsonMember(payload,"managementTargetV1",target,bound)) return false;
   if(!bound) {
      bool attributed=false;
      if(!ArxJsonMember(payload,"agentOwnership",raw,attributed) || attributed) return false;
      if(!ArxJsonMember(payload,"selfTradeSymbolBinding",raw,attributed) || attributed) return false;
      return true;
   }
   double version,volume,oldSL,oldTP,nextSL;
   string login,server,symbol,side,targetTicket,targetAction,wireSymbol;
   if(!ArxTargetNumber(target,"version",version) || version!=1 ||
      !ArxTargetString(target,"accountLogin",login) || !ArxPositiveDecimal(login) ||
      !ArxTargetString(target,"observedServerName",server) ||
      !ArxTargetString(target,"symbol",symbol) ||
      !ArxTargetString(target,"side",side) || (side!="BUY" && side!="SELL") ||
      !ArxTargetString(target,"brokerTicket",targetTicket) || !ArxPositiveDecimal(targetTicket) ||
      !ArxTargetString(target,"action",targetAction) ||
      !ArxTargetNumber(target,"volume",volume) || volume<=0 ||
      !ArxTargetNumber(target,"currentStopLoss",oldSL,true) || oldSL<0 ||
      !ArxTargetNumber(target,"currentTakeProfit",oldTP,true) || oldTP<0 ||
      !ArxTargetString(wire,"symbol",wireSymbol) || wireSymbol!=symbol) return false;
   bool close=(action=="CLOSE_POSITION" || action=="CLOSE_LIVE_POSITION");
   bool modify=(action=="MODIFY_POSITION" || action=="MODIFY_POSITION_PROTECTION" || action=="MODIFY_LIVE_SLTP" || action=="MOVE_SL" || action=="MOVE_TP");
   if((!close && !modify) || (close && targetAction!="EXIT") ||
      (modify && targetAction!="MOVE_TO_BE" && targetAction!="TIGHTEN_SL") ||
      ticket!=(ulong)StringToInteger(targetTicket)) return false;
   if(modify && (!ArxTargetNumber(target,"nextStopLoss",nextSL) || nextSL<=0 ||
      !ArxSameValue(sl,nextSL) || !ArxSameValue(tp,oldTP))) return false;
   reason="MANAGEMENT_ACCOUNT_MISMATCH";
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE)!=ACCOUNT_TRADE_MODE_REAL ||
      IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))!=login ||
      AccountInfoString(ACCOUNT_SERVER)!=server) return false;
   reason="MANAGEMENT_POSITION_MISMATCH";
   if(!PositionSelectByTicket(ticket) || PositionGetString(POSITION_SYMBOL)!=symbol ||
      PositionGetInteger(POSITION_TYPE)!=(side=="BUY"?POSITION_TYPE_BUY:POSITION_TYPE_SELL) ||
      !ArxSameValue(PositionGetDouble(POSITION_VOLUME),volume) ||
      !ArxSameValue(PositionGetDouble(POSITION_SL),oldSL) ||
      !ArxSameValue(PositionGetDouble(POSITION_TP),oldTP)) return false;
   // Recheck after selection, too: copied position facts must not mask a
   // changed terminal account. This is still not an atomic terminal lock.
   reason="MANAGEMENT_ACCOUNT_MISMATCH";
   if(IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN))!=login || AccountInfoString(ACCOUNT_SERVER)!=server ||
      AccountInfoInteger(ACCOUNT_TRADE_MODE)!=ACCOUNT_TRADE_MODE_REAL) return false;
   reason=""; return true;
}
#endif
