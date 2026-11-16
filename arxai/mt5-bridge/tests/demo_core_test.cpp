// Test doubles only; this executable has no networking or broker libraries.
#include <cmath>
#include <algorithm>
#include <cctype>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>
#include <sstream>
using string = std::string;
using ushort = unsigned short;
using uint = unsigned int;
using ulong = unsigned long;
enum { ACCOUNT_TRADE_MODE, ACCOUNT_MARGIN_MODE, ACCOUNT_TRADE_MODE_DEMO,
 ACCOUNT_MARGIN_MODE_RETAIL_HEDGING, TERMINAL_CONNECTED, TERMINAL_TRADE_ALLOWED,
 MQL_TRADE_ALLOWED, ACCOUNT_TRADE_ALLOWED, ACCOUNT_TRADE_EXPERT, ACCOUNT_LOGIN,
 ACCOUNT_SERVER, SYMBOL_VOLUME_MIN, SYMBOL_VOLUME_STEP, SYMBOL_VOLUME_MAX,
 SYMBOL_POINT, POSITION_SYMBOL, POSITION_VOLUME, POSITION_SL, POSITION_TP,
 POSITION_IDENTIFIER, DEAL_POSITION_ID, ORDER_TYPE_SELL, ORDER_TYPE_BUY,
 TRADE_RETCODE_DONE, TRADE_RETCODE_DONE_PARTIAL, TRADE_RETCODE_NO_CHANGES };
// v1.32 pending-order vocabulary (values are arbitrary test doubles).
enum { ORDER_TYPE_BUY_LIMIT=200, ORDER_TYPE_SELL_LIMIT, ORDER_TYPE_BUY_STOP, ORDER_TYPE_SELL_STOP,
 ORDER_TYPE_BUY_STOP_LIMIT, ORDER_TYPE_SELL_STOP_LIMIT, ORDER_TIME_GTC, ORDER_TIME_SPECIFIED,
 TRADE_RETCODE_PLACED, TRADE_ACTION_PENDING, SYMBOL_TRADE_TICK_SIZE, SYMBOL_DIGITS, SYMBOL_FILLING_MODE,
 ORDER_SYMBOL, ORDER_PRICE_OPEN, ORDER_VOLUME_INITIAL, ORDER_TYPE, ORDER_STATE, ORDER_STATE_CANCELED,
 ORDER_STATE_FILLED, ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN };
const long SYMBOL_FILLING_FOK=1, SYMBOL_FILLING_IOC=2;
using datetime = long;
typedef int ENUM_ORDER_TYPE;
typedef int ENUM_ORDER_TYPE_TIME;
const int INVALID_HANDLE=-1;
const int FILE_READ=1, FILE_WRITE=2, FILE_TXT=4, FILE_UNICODE=8, FILE_COMMON=16;
bool EnableDemoExecution=true, ReadOnlyMode=false, g_maintenanceMode=false;
double DemoMaxLot=1, g_maxDeviationPoints=20;
std::map<int,long> info;
double currentVolume=.02, currentSL=1.1, currentTP=1.2, brokerVolume=.01, brokerPrice=1.15;
double requested=0, minimum=.01, step=.01, maximum=100;
bool positionExists=true, brokerBool=true, filling=true, guardPass=true, updateModify=true;
bool symbolOk=true, dealAvailable=true, fileBlocked=false, writeFails=false, flushFails=false;
uint brokerCode=TRADE_RETCODE_DONE;
int calls=0, selectedSide=-1, errorCode=0, checks=0;
ulong selectedTicket=0;
string operation, response, posted;
std::map<string,string> disk;
struct File { string path; size_t cursor=0; };
std::map<int,File> handles;
int nextHandle=1;
int StringLen(const string &s) { return (int)s.size(); }
int StringFind(const string &s,const string &q,int start=0) { auto n=s.find(q,start);return n==string::npos?-1:(int)n; }
string StringSubstr(const string &s,int start,int len=-1) { return s.substr(start,len<0?string::npos:(size_t)len); }
ushort StringGetCharacter(const string &s,int i) { return s.at(i); }
string ShortToString(ushort c) { return string(1,(char)c); }
long StringToInteger(const string &s) { try{return std::stol(s);}catch(...){return 0;} }
double StringToDouble(const string &s) { try{return std::stod(s);}catch(...){return 0;} }
void StringToLower(string &s) {std::transform(s.begin(),s.end(),s.begin(),[](unsigned char c){return std::tolower(c);});}
void StringToUpper(string &s) {std::transform(s.begin(),s.end(),s.begin(),[](unsigned char c){return std::toupper(c);});}
string IntegerToString(long n) { return std::to_string(n); }
bool MathIsValidNumber(double n) { return std::isfinite(n); }
double MathAbs(double n) { return std::abs(n); }
double MathRound(double n) { return std::round(n); }
double NormalizeDouble(double v,int d) { double f=std::pow(10.0,d);return std::round(v*f)/f; }
long AccountInfoInteger(int k) { return info[k]; }
long TerminalInfoInteger(int k) { return info[k]; }
long MQLInfoInteger(int k) { return info[k]; }
string AccountInfoString(int) { return "TEST_SERVER"; }
bool SymbolSelect(const string&,bool) { return symbolOk; }
double SymbolInfoDouble(const string&,int k) { return k==SYMBOL_VOLUME_MIN?minimum:k==SYMBOL_VOLUME_STEP?step:k==SYMBOL_VOLUME_MAX?maximum:.00001; }
long SymbolInfoInteger(const string&,int k) { return k==SYMBOL_DIGITS?5:k==SYMBOL_FILLING_MODE?SYMBOL_FILLING_IOC:0; }
// Fake trade server clock (UTC + 2h, with 13 s of tick jitter) and order book.
datetime gmtNow=1800000000, serverNow=1800000000+7200+13;
datetime TimeGMT() { return gmtNow; }
datetime TimeTradeServer() { return serverNow; }
ulong tickNow=1000, tickStep=0;
ulong GetTickCount64() { ulong t=tickNow; tickNow+=tickStep; return t; }
struct FakeOrder { string symbol; int type; double price; double volume; };
std::map<ulong,FakeOrder> book;
ulong brokerOrder=5001, selectedOrder=0;
bool bookOnPlace=true, deleteRemoves=true, historyHas=true;
long historyState=ORDER_STATE_CANCELED;
double placedPrice=0, placedLimit=0, placedSL=0, placedTP=0;
int placedType=-1, placedTime=-1, placedFilling=-1;
datetime placedExpiry=-1;
bool OrderSelect(ulong t) { if(!book.count(t))return false;selectedOrder=t;return true; }
string OrderGetString(int) { return book.at(selectedOrder).symbol; }
double OrderGetDouble(int k) { auto &o=book.at(selectedOrder);return k==ORDER_PRICE_OPEN?o.price:o.volume; }
long OrderGetInteger(int) { return book.at(selectedOrder).type; }
bool HistoryOrderSelect(ulong) { return historyHas; }
long HistoryOrderGetInteger(ulong,int) { return historyState; }
struct MqlTradeRequest { int action=0; string symbol; double volume=0; int type=0; double price=0, stoplimit=0, sl=0, tp=0;
 int type_time=0; datetime expiration=0; int type_filling=0; string comment; };
struct MqlTradeResult { uint retcode=0; ulong order=0; };
template<class T> void ZeroMemory(T &t) { t=T{}; }
void place(const string &op,const string &sym,int type,double v,double price,double limit,double sl,double tp,int tmode,datetime exp)
{
 ++calls;operation=op;requested=v;placedType=type;placedPrice=price;placedLimit=limit;placedSL=sl;placedTP=tp;placedTime=tmode;placedExpiry=exp;
 if((brokerCode==TRADE_RETCODE_PLACED||brokerCode==TRADE_RETCODE_DONE)&&brokerBool&&bookOnPlace&&brokerOrder>0)book[brokerOrder]={sym,type,price,v};
}
bool OrderSend(const MqlTradeRequest &r,MqlTradeResult &res)
{
 if(r.action!=TRADE_ACTION_PENDING)throw std::runtime_error("raw request must be TRADE_ACTION_PENDING");
 placedFilling=r.type_filling;place("pending_raw",r.symbol,r.type,r.volume,r.price,r.stoplimit,r.sl,r.tp,r.type_time,r.expiration);
 res.retcode=brokerCode;res.order=brokerOrder;return brokerBool;
}
bool PositionSelectByTicket(ulong t) { return positionExists && t==42; }
string PositionGetString(int) { return "EURUSD"; }
double PositionGetDouble(int k) { return k==POSITION_VOLUME?currentVolume:k==POSITION_SL?currentSL:currentTP; }
long PositionGetInteger(int) { return 777; }
bool HistoryDealSelect(ulong) { return dealAvailable; }
long HistoryDealGetInteger(ulong,int) { return 777; }
int PositionsTotal() { return positionExists?1:0; }
ulong PositionGetTicket(int) { return 42; }
bool PreTradeBrokerGuard(const string&,const string&,double,double,double,double,double,string &reason)
{ reason="REJECTED_TEST_BROKER_GUARD"; return guardPass; }
struct CTrade {
 void SetAsyncMode(bool) {}
 void SetDeviationInPoints(double) {}
 bool SetTypeFillingBySymbol(const string&) { return filling; }
 bool PositionOpen(const string&,int side,double v,double,double,double,const string&) {++calls;operation="entry";requested=v;selectedSide=side;return brokerBool;}
 bool PositionClosePartial(ulong t,double v,double) {++calls;operation="close_partial";requested=v;selectedTicket=t;return brokerBool;}
 bool PositionModify(ulong t,double sl,double tp) {++calls;operation="modify";selectedTicket=t;if(updateModify){currentSL=sl;currentTP=tp;}return brokerBool;}
 uint ResultRetcode() {return brokerCode;}
 double ResultPrice() {return brokerPrice;}
 double ResultVolume() {return brokerVolume;}
 ulong ResultDeal() {return 900;}
 ulong ResultOrder() {return brokerOrder;}
 bool BuyLimit(double v,double p,const string &s,double sl,double tp,int tt,datetime e,const string&) {place("buy_limit",s,ORDER_TYPE_BUY_LIMIT,v,p,0,sl,tp,tt,e);return brokerBool;}
 bool SellLimit(double v,double p,const string &s,double sl,double tp,int tt,datetime e,const string&) {place("sell_limit",s,ORDER_TYPE_SELL_LIMIT,v,p,0,sl,tp,tt,e);return brokerBool;}
 bool BuyStop(double v,double p,const string &s,double sl,double tp,int tt,datetime e,const string&) {place("buy_stop",s,ORDER_TYPE_BUY_STOP,v,p,0,sl,tp,tt,e);return brokerBool;}
 bool SellStop(double v,double p,const string &s,double sl,double tp,int tt,datetime e,const string&) {place("sell_stop",s,ORDER_TYPE_SELL_STOP,v,p,0,sl,tp,tt,e);return brokerBool;}
 bool OrderDelete(ulong t) {++calls;operation="order_delete";selectedTicket=t;if(brokerBool&&deleteRemoves)book.erase(t);return brokerBool;}
} g_demoTrade;
void ResetLastError() {errorCode=0;}
int GetLastError() {return errorCode;}
int FileOpen(const string &name,int flags) {
 if(fileBlocked)return INVALID_HANDLE;
 if(flags!=(FILE_READ|FILE_WRITE|FILE_TXT|FILE_UNICODE|FILE_COMMON))throw std::runtime_error("journal must be exclusive");
 for(auto &h:handles)if(h.second.path==name)return INVALID_HANDLE;
 int h=nextHandle++;handles[h]={name,0};return h;
}
size_t FileSize(int h) {return disk[handles.at(h).path].size();}
string FileReadString(int h) {
 auto &f=handles.at(h);auto &s=disk[f.path];if(f.cursor>=s.size())return "";
 size_t n=s.find("\r\n",f.cursor);if(n==string::npos)n=s.size();
 string out=s.substr(f.cursor,n-f.cursor);f.cursor=n+2;return out;
}
uint FileWriteString(int h,const string &s) {if(writeFails){errorCode=1;return 0;}auto &f=handles.at(h);disk[f.path].append(s);f.cursor+=s.size();return (uint)s.size()*2;}
void FileFlush(int) {if(flushFails)errorCode=1;}
void FileClose(int h) {handles.erase(h);}
// Deterministic fake digest for journal corruption scenarios; real MQL uses SHA256.
string Sha256Hex(const string &s) {std::ostringstream o;o<<std::hex<<std::hash<string>{}(s);string d=o.str();return string(64-d.size(),'0')+d;}
bool HttpPost(const string&,const string &body,string&,const string&) {posted=body;return true;}
bool HttpGet(const string&,string &out,const string&) {out=response;return true;}
void WriteBackDemoResult(const string&,const string&,const string&,ulong,double,double,const string& = "",const string& = "");
#include "ArxDemoExecution.mqh"
ArxDemoOutcome last;
void WriteBackDemoResult(const string&,const string &status,const string &reason,ulong t,double p,double v,const string&,const string&) {
 last.status=status;last.reason=reason;last.ticket=t;last.price=p;last.volume=v;
 posted=status+"|"+reason+"|"+std::to_string(t)+"|"+std::to_string(p)+"|"+std::to_string(v);
 PersistDemoResult(posted);
}
#include "ea_wire.inc"
void check(bool ok,const string &label) {if(!ok)throw std::runtime_error(label);++checks;}
void reset() {
 info={{ACCOUNT_TRADE_MODE,ACCOUNT_TRADE_MODE_DEMO},{ACCOUNT_MARGIN_MODE,ACCOUNT_MARGIN_MODE_RETAIL_HEDGING},
 {TERMINAL_CONNECTED,1},{TERMINAL_TRADE_ALLOWED,1},{MQL_TRADE_ALLOWED,1},{ACCOUNT_TRADE_ALLOWED,1},{ACCOUNT_TRADE_EXPERT,1},{ACCOUNT_LOGIN,100}};
 EnableDemoExecution=true;ReadOnlyMode=false;g_maintenanceMode=false;currentVolume=.02;currentSL=1.1;currentTP=1.2;
 brokerVolume=.01;brokerPrice=1.15;requested=0;minimum=.01;step=.01;maximum=100;positionExists=true;
 brokerBool=true;filling=true;guardPass=true;updateModify=true;symbolOk=true;dealAvailable=true;
 brokerCode=TRADE_RETCODE_DONE;calls=0;operation="";posted="";handles.clear();disk.clear();
 fileBlocked=false;writeFails=false;flushFails=false;g_demoJournal=INVALID_HANDLE;
 book.clear();brokerOrder=5001;selectedOrder=0;bookOnPlace=true;deleteRemoves=true;historyHas=true;historyState=ORDER_STATE_CANCELED;
 placedPrice=placedLimit=placedSL=placedTP=0;placedType=placedTime=placedFilling=-1;placedExpiry=-1;tickNow=1000;tickStep=0;
 gmtNow=1800000000;serverNow=1800000000+7200+13;last=ArxDemoOutcome();
}
ArxDemoOutcome run(const string &kind="CLOSE_POSITION",double v=.01,const string &sym="EURUSD",const string &side="buy",ulong ticket=42) {
 ArxDemoOutcome o;ExecuteDemoCommand(kind,sym,side,ticket,v,1.11,1.21,o);return o;
}
#ifdef ARX_V132
ArxDemoRequest pendingReq(const string &type="BUY_LIMIT",double entry=1.100004,double limit=0,long exp=0,const string &side="buy") {
 ArxDemoRequest r;r.kind="PLACE_PENDING_ORDER";r.symbol="EURUSD";r.side=side;r.ticket=0;r.volume=.02;
 r.sl=1.090004;r.tp=1.120006;r.orderType=type;r.entry=entry;r.stopLimit=limit;r.expirationEpoch=exp;r.orderTicket=0;return r;
}
ArxDemoRequest cancelReq(ulong t=5001,const string &sym="EURUSD") {
 ArxDemoRequest r;r.kind="CANCEL_PENDING_ORDER";r.symbol=sym;r.side="";r.ticket=0;r.volume=0;r.sl=0;r.tp=0;
 r.orderType="";r.entry=0;r.stopLimit=0;r.expirationEpoch=0;r.orderTicket=t;return r;
}
ArxDemoOutcome exec(const ArxDemoRequest &r) { ArxDemoOutcome o;ExecuteDemoRequest(r,o);return o; }
void pendingChecks() {
 bool near=true;
 reset();brokerCode=TRADE_RETCODE_PLACED;auto o=exec(pendingReq());
 near=std::abs(placedPrice-1.1)<1e-12 && std::abs(placedSL-1.09)<1e-12 && std::abs(placedTP-1.12001)<1e-12;
 check(o.status=="PLACED_DEMO" && o.ticket==5001 && operation=="buy_limit" && near && placedTime==ORDER_TIME_GTC && placedExpiry==0
   && o.volume==.02 && std::abs(o.price-1.1)<1e-12,"buy limit: tick-normalised prices, GTC, PLACED_DEMO with the verified order ticket");
 reset();o=exec(pendingReq());check(o.status=="PLACED_DEMO","TRADE_RETCODE_DONE also confirms a placement");
 for(auto t:{std::make_pair("SELL_LIMIT","sell_limit"),std::make_pair("BUY_STOP","buy_stop"),std::make_pair("SELL_STOP","sell_stop")}){
  reset();brokerCode=TRADE_RETCODE_PLACED;o=exec(pendingReq(t.first,1.1,0,0,t.first[0]=='S'?"sell":"buy"));
  check(o.status=="PLACED_DEMO" && operation==t.second,"CTrade helper per pending type");}
 reset();brokerCode=TRADE_RETCODE_PLACED;o=exec(pendingReq("BUY_LIMIT",1.1,0,gmtNow+3600));
 check(o.status=="PLACED_DEMO" && placedTime==ORDER_TIME_SPECIFIED && placedExpiry==gmtNow+3600+7200,"UTC expiry -> trade-server time (offset rounded to 30 min), ORDER_TIME_SPECIFIED");
 reset();serverNow=gmtNow-3*3600+5;brokerCode=TRADE_RETCODE_PLACED;o=exec(pendingReq("BUY_LIMIT",1.1,0,gmtNow+3600));
 check(placedExpiry==gmtNow+3600-3*3600,"negative server offset");
 reset();o=exec(pendingReq("BUY_LIMIT",1.1,0,gmtNow-60));check(calls==0 && o.reason=="REJECTED_EXPIRATION_IN_PAST","expired order time refused before the broker");
 reset();brokerCode=TRADE_RETCODE_PLACED;o=exec(pendingReq("BUY_STOP_LIMIT",1.105,1.103004));
 check(o.status=="PLACED_DEMO" && operation=="pending_raw" && placedType==ORDER_TYPE_BUY_STOP_LIMIT && std::abs(placedLimit-1.103)<1e-12
   && std::abs(placedPrice-1.105)<1e-12 && placedFilling==ORDER_FILLING_IOC,"stop limit uses a raw TRADE_ACTION_PENDING request with stoplimit");
 reset();o=exec(pendingReq("SELL_STOP_LIMIT",1.095,0,0,"sell"));check(calls==0 && o.reason=="REJECTED_INVALID_STOP_LIMIT_PRICE","stop limit needs its limit price");
 reset();o=exec(pendingReq("BUY_LIMIT",0));check(calls==0 && o.reason=="REJECTED_INVALID_PENDING_PRICE","pending price required");
 reset();o=exec(pendingReq("MARKET_BUY"));check(calls==0 && o.reason=="REJECTED_INVALID_ORDER_TYPE","non-pending type refused");
 reset();o=exec(pendingReq("BUY_LIMIT",1.1,0,0,"sell"));check(calls==0 && o.reason=="REJECTED_INVALID_SIDE","side must match order type");
 reset();g_maintenanceMode=true;o=exec(pendingReq());check(calls==0 && o.reason=="REJECTED_MAINTENANCE_MODE","maintenance blocks new pending orders");
 reset();ReadOnlyMode=true;o=exec(pendingReq());check(calls==0 && o.reason=="REJECTED_READ_ONLY_MODE_ACTIVE","demo guard precedes pending");
 reset();{auto r=pendingReq();r.volume=2;o=exec(r);}check(calls==0 && o.reason=="REJECTED_LOT_EXCEEDS_CEILING","lot ceiling");
 reset();{auto r=pendingReq();r.volume=.025;o=exec(r);}check(calls==0 && o.reason=="REJECTED_INVALID_VOLUME_PAYLOAD","volume step");
 reset();{auto r=pendingReq();r.sl=NAN;o=exec(r);}check(calls==0 && o.reason=="REJECTED_INVALID_STOPS","non-finite stop");
 reset();filling=false;o=exec(pendingReq());check(calls==0,"unsupported filling");
 reset();brokerCode=999;o=exec(pendingReq());check(o.status=="FAILED" && o.reason.find("DO_NOT_RETRY")!=string::npos,"other retcode is uncertain, never retried");
 reset();brokerCode=TRADE_RETCODE_PLACED;bookOnPlace=false;o=exec(pendingReq());check(o.status=="FAILED","order not found by OrderSelect is uncertain");
 reset();brokerCode=TRADE_RETCODE_PLACED;brokerOrder=0;o=exec(pendingReq());check(o.status=="FAILED","no order ticket is uncertain");
 reset();brokerCode=TRADE_RETCODE_PLACED;brokerBool=false;o=exec(pendingReq());check(o.status=="FAILED","false send is uncertain");
 // Cancel.
 reset();book[5001]={"EURUSD",ORDER_TYPE_BUY_LIMIT,1.1,.02};o=exec(cancelReq());
 check(o.status=="CANCELLED_DEMO" && o.ticket==5001 && operation=="order_delete" && !book.count(5001),"cancel deletes and verifies the order is gone");
 reset();g_maintenanceMode=true;book[5001]={"EURUSD",ORDER_TYPE_BUY_LIMIT,1.1,.02};o=exec(cancelReq());check(o.status=="CANCELLED_DEMO","maintenance never blocks a cancel");
 reset();o=exec(cancelReq());check(calls==0 && o.reason=="REJECTED_ORDER_NOT_FOUND","missing order");
 reset();book[5001]={"GBPUSD",ORDER_TYPE_BUY_LIMIT,1.1,.02};o=exec(cancelReq());check(calls==0 && o.reason=="REJECTED_ORDER_SYMBOL_MISMATCH","symbol must match");
 reset();book[5001]={"EURUSD",ORDER_TYPE_BUY,1.1,.02};o=exec(cancelReq());check(calls==0 && o.reason=="REJECTED_NOT_A_PENDING_ORDER","market order is not cancellable");
 reset();deleteRemoves=false;book[5001]={"EURUSD",ORDER_TYPE_BUY_LIMIT,1.1,.02};o=exec(cancelReq());check(o.status=="FAILED","order still active after delete is uncertain");
 reset();historyState=ORDER_STATE_FILLED;book[5001]={"EURUSD",ORDER_TYPE_BUY_LIMIT,1.1,.02};o=exec(cancelReq());check(o.status=="FAILED","history says filled: not a cancel");
 reset();brokerCode=999;book[5001]={"EURUSD",ORDER_TYPE_BUY_LIMIT,1.1,.02};o=exec(cancelReq());check(o.status=="FAILED","cancel retcode must be DONE");
 // TTL.
 check(!DemoCommandExpired(-1,999999999) && DemoCommandExpired(0,0) && !DemoCommandExpired(5,4999) && DemoCommandExpired(5,5000),"command TTL arithmetic");
 // Wire.
 reset();brokerCode=TRADE_RETCODE_PLACED;response=R"({"commands":[{"commandId":"wire-p1","commandType":"PLACE_PENDING_ORDER","payload":{"symbol":"EURUSD","side":"BUY","lotSize":0.02,"orderType":"BUY_STOP_LIMIT","price":1.105,"stopLimitPrice":1.103,"expirationEpoch":1800003600,"stopLoss":1.09,"takeProfit":1.12},"sentAt":"x","secondsUntilExpiry":90,"expiresAtEpoch":1800000090}]})";
 PollAndExecuteDemoCommands();check(calls==1 && last.status=="PLACED_DEMO" && last.ticket==5001 && std::abs(placedPrice-1.105)<1e-12 && std::abs(placedLimit-1.103)<1e-12 && placedExpiry==1800003600+7200,"wire: pending fields with price fallback, stop limit and expiry");
 reset();tickStep=6000;response=R"({"commands":[{"commandId":"wire-p2","commandType":"PLACE_PENDING_ORDER","payload":{"symbol":"EURUSD","side":"BUY","lotSize":0.02,"orderType":"BUY_LIMIT","entry":1.1},"secondsUntilExpiry":5}]})";
 PollAndExecuteDemoCommands();check(calls==0 && last.status=="FAILED" && last.reason=="EXPIRED_BEFORE_EXECUTION","wire: TTL elapsed before execution -> FAILED, no broker call");
 reset();brokerCode=TRADE_RETCODE_PLACED;response=R"({"commands":[{"commandId":"wire-p3","commandType":"PLACE_PENDING_ORDER","payload":{"symbol":"EURUSD","side":"SELL","lotSize":0.02,"orderType":"SELL_LIMIT","entry":1.13,"price":1.2}}]})";
 PollAndExecuteDemoCommands();check(calls==1 && operation=="sell_limit" && std::abs(placedPrice-1.13)<1e-12,"wire: entry wins over price; no TTL key keeps legacy behaviour");
 reset();book[5001]={"EURUSD",ORDER_TYPE_BUY_LIMIT,1.1,.02};response=R"({"commands":[{"commandId":"wire-c1","commandType":"CANCEL_PENDING_ORDER","payload":{"symbol":"EURUSD","orderTicket":"5001","ticket":"5001"},"secondsUntilExpiry":60}]})";
 PollAndExecuteDemoCommands();check(calls==1 && last.status=="CANCELLED_DEMO" && last.ticket==5001,"wire: cancel by string orderTicket");
 reset();response=R"({"commands":[{"commandId":"wire-m1","commandType":"CLOSE_POSITION","payload":{"ticket":"42","symbol":"EURUSD","lotSize":0.01},"secondsUntilExpiry":60}]})";
 PollAndExecuteDemoCommands();check(calls==1 && requested==.01 && last.status=="FILLED_DEMO","wire: existing commands still route through ExecuteDemoCommand");
}
#endif
int main() {
 try {
 reset();auto o=run();check(o.status=="FILLED_DEMO" && requested==.01 && selectedTicket==42 && operation=="close_partial" && o.ticket==42 && o.volume==.01,"partial keeps exact size/ticket/fill");
 reset();brokerVolume=.02;o=run("CLOSE_POSITION",.02);check(o.status=="FILLED_DEMO" && requested==.02 && operation=="close_partial","full close is still bounded");
 for(double v:{0.,-.01,.025,.03,(double)NAN,(double)INFINITY}){reset();o=run("CLOSE_POSITION",v);check(calls==0 && o.status=="REJECTED","invalid close volume refuses");}
 reset();currentVolume=.025;o=run();check(calls==0,"invalid remainder refuses");
 reset();o=run("CLOSE_POSITION",.01,"GBPUSD");check(calls==0,"symbol mismatch refuses");
 reset();o=run("CLOSE_POSITION",.01,"EURUSD","buy",999);check(calls==0,"missing ticket refuses");
 reset();step=0;o=run();check(calls==0,"unknown volume rules refuse");
 for(int k:{ACCOUNT_TRADE_MODE,ACCOUNT_MARGIN_MODE,TERMINAL_CONNECTED,TERMINAL_TRADE_ALLOWED,MQL_TRADE_ALLOWED,ACCOUNT_TRADE_ALLOWED,ACCOUNT_TRADE_EXPERT}){reset();info[k]=-1;if(k!=ACCOUNT_TRADE_MODE && k!=ACCOUNT_MARGIN_MODE)info[k]=0;o=run("PLACE_MARKET_ORDER",.02);check(calls==0,"account/terminal guard precedes entry");}
 reset();EnableDemoExecution=false;o=run();check(calls==0,"demo arm off");
 reset();ReadOnlyMode=true;o=run();check(calls==0,"read only");
 reset();g_maintenanceMode=true;o=run("PLACE_MARKET_ORDER",.02);check(calls==0,"maintenance blocks entry");o=run();check(calls==1,"maintenance permits reduction");
 reset();o=run("PLACE_MARKET_ORDER",.02,"EURUSD","invalid");check(calls==0,"invalid side never defaults to buy");
 reset();o=run("PLACE_MARKET_ORDER",.005);check(calls==0,"never round up entry");
 reset();o=run("PLACE_MARKET_ORDER",2);check(calls==0,"entry ceiling");
 reset();guardPass=false;o=run("PLACE_MARKET_ORDER",.02);check(calls==0,"broker guard");
 reset();filling=false;o=run();check(calls==0,"unsupported filling");
 reset();brokerCode=999;o=run();check(o.status=="FAILED" && o.reason.find("DO_NOT_RETRY")!=string::npos,"true request bool is not broker success");
 reset();brokerBool=false;o=run();check(o.status=="FAILED","false send cannot fill");
 reset();brokerVolume=0;o=run();check(o.status=="FAILED","missing volume never substitutes request");
 reset();brokerPrice=0;o=run();check(o.status=="FAILED","missing price never substitutes quote");
 reset();brokerVolume=.02;o=run();check(o.status=="FAILED","oversized fill cannot pass");
 reset();brokerCode=TRADE_RETCODE_DONE_PARTIAL;brokerVolume=.01;o=run("PLACE_MARKET_ORDER",.02);check(o.status=="FILLED_DEMO" && o.volume==.01 && o.ticket==42,"partial entry reports actual volume and position ticket");
 reset();dealAvailable=false;o=run("PLACE_MARKET_ORDER",.02);check(o.status=="FAILED","missing position mapping is uncertain");
 reset();o=run("MODIFY_SLTP",0);check(o.status=="FILLED_DEMO" && o.ticket==42 && o.volume==0 && o.price==0,"modify reports ticket without invented fill");
 reset();updateModify=false;o=run("MODIFY_SLTP",0);check(o.status=="FAILED","modify needs actual stop readback");
 reset();brokerCode=TRADE_RETCODE_NO_CHANGES;o=run("MODIFY_SLTP",0);check(o.status=="FILLED_DEMO","idempotent matching modify");
 reset();fileBlocked=true;check(BeginDemoCommand("a")==0,"journal unavailable");
 reset();writeFails=true;check(BeginDemoCommand("a")==0,"intent write failure");
 reset();flushFails=true;check(BeginDemoCommand("a")==0,"intent flush failure");
 reset();check(BeginDemoCommand("a")==1,"new intent claims");int held=g_demoJournal;check(BeginDemoCommand("a")==0,"second chart cannot claim");g_demoJournal=held;PersistDemoResult("saved-result");check(BeginDemoCommand("a")==0 && posted=="saved-result","lost HTTP ack replays exact result");
 reset();check(BeginDemoCommand("a")==1,"crash intent claims");FileClose(g_demoJournal);g_demoJournal=INVALID_HANDLE;check(BeginDemoCommand("a")==0 && last.status=="FAILED" && last.reason.find("DO_NOT_RETRY")!=string::npos,"restart refuses uncertain intent");
 reset();BeginDemoCommand("a");PersistDemoResult("saved-result");disk.begin()->second.back()='x';check(BeginDemoCommand("a")==0 && last.status=="FAILED","truncated/corrupt result never reexecutes");
 reset();response=R"({"commands":[{"commandId":"wire-1","commandType":"CLOSE_POSITION","payload":{"ticket":"42","symbol":"EURUSD","volume":0.01,"lot":0.01}}]})";PollAndExecuteDemoCommands();string first=posted;check(calls==1 && requested==.01 && last.ticket==42,"actual wire poll reads string ticket and volume");PollAndExecuteDemoCommands();check(calls==1 && posted==first,"poll retry makes no second broker call");
 reset();response=R"({"commands":[{"commandId":"wire-2","commandType":"CLOSE_POSITION","payload":{"ticket":42,"symbol":"EURUSD","lot":0.01}}]})";PollAndExecuteDemoCommands();check(calls==1 && requested==.01,"legacy numeric ticket and lot");
 reset();response=R"({"commands":[{"commandId":"wire-3","commandType":"CLOSE_POSITION","payload":{"ticket":"42","symbol":"EURUSD","volume":0,"lot":0.01}}]})";PollAndExecuteDemoCommands();check(calls==0,"invalid canonical volume cannot use alias");
 reset();check(DemoReadTicket(R"({"ticket":"42x"})")==0 && DemoReadTicket(R"({"ticket":"-42"})")==0,"invalid string tickets refuse");
 reset();response=R"({"commands":[{"commandId":"governed-open","commandType":"PLACE_MARKET_ORDER","payload":{"symbol":"EURUSD","side":"SELL","lotSize":0.02,"stopLoss":1.11,"takeProfit":1.21}}]})";PollAndExecuteDemoCommands();check(calls==1 && requested==.02 && selectedSide==ORDER_TYPE_SELL,"governed entry fields and uppercase SELL");
 reset();response=R"({"commands":[{"commandId":"governed-close","commandType":"CLOSE_POSITION","payload":{"ticket":"42","symbol":"EURUSD","side":"BUY","lotSize":0.01}}]})";PollAndExecuteDemoCommands();check(calls==1 && requested==.01,"governed close lotSize");
 reset();response=R"({"commands":[{"commandId":"governed-modify","commandType":"MODIFY_SLTP","payload":{"ticket":"42","symbol":"EURUSD","lotSize":0.02,"stopLoss":1.12,"takeProfit":null}}]})";PollAndExecuteDemoCommands();check(calls==1 && currentSL==1.12 && currentTP==0 && last.ticket==42,"governed modify stopLoss and null takeProfit");
 reset();response=R"({"commands":[{"commandId":"governed-invalid","commandType":"CLOSE_POSITION","payload":{"ticket":"42","symbol":"EURUSD","lotSize":0,"volume":0.01}}]})";PollAndExecuteDemoCommands();check(calls==0,"governed invalid lotSize cannot use alias");
 #ifdef ARX_V132
 pendingChecks();
 #endif
 std::cout<<checks<<" DEMO bridge behavioral checks passed; zero broker/network calls.\n";
 } catch(const std::exception &e){std::cerr<<"FAIL: "<<e.what()<<"\n";return 1;}
}
