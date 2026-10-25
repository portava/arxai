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
string IntegerToString(long n) { return std::to_string(n); }
bool MathIsValidNumber(double n) { return std::isfinite(n); }
double MathAbs(double n) { return std::abs(n); }
double MathRound(double n) { return std::round(n); }
long AccountInfoInteger(int k) { return info[k]; }
long TerminalInfoInteger(int k) { return info[k]; }
long MQLInfoInteger(int k) { return info[k]; }
string AccountInfoString(int) { return "TEST_SERVER"; }
bool SymbolSelect(const string&,bool) { return symbolOk; }
double SymbolInfoDouble(const string&,int k) { return k==SYMBOL_VOLUME_MIN?minimum:k==SYMBOL_VOLUME_STEP?step:k==SYMBOL_VOLUME_MAX?maximum:.00001; }
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
}
ArxDemoOutcome run(const string &kind="CLOSE_POSITION",double v=.01,const string &sym="EURUSD",const string &side="buy",ulong ticket=42) {
 ArxDemoOutcome o;ExecuteDemoCommand(kind,sym,side,ticket,v,1.11,1.21,o);return o;
}
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
 std::cout<<checks<<" DEMO bridge behavioral checks passed; zero broker/network calls.\n";
 } catch(const std::exception &e){std::cerr<<"FAIL: "<<e.what()<<"\n";return 1;}
}
