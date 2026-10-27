// Actual extracted MQL functions run against a synthetic terminal; no network.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <functional>
#include <fstream>
#include <sstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
using string=std::string;using ushort=unsigned short;using ulong=unsigned long;
enum {ACCOUNT_LOGIN,ACCOUNT_SERVER,ACCOUNT_TRADE_MODE,ACCOUNT_TRADE_MODE_REAL,ACCOUNT_TRADE_MODE_DEMO,
 TERMINAL_CONNECTED,POSITION_SYMBOL,POSITION_TYPE,POSITION_TYPE_BUY,POSITION_TYPE_SELL,POSITION_VOLUME,POSITION_SL,POSITION_TP,SYMBOL_ASK,SYMBOL_BID,ORDER_TYPE_BUY,ORDER_TYPE_SELL,TRADE_RETCODE_DONE=10009};
long login=100,mode=ACCOUNT_TRADE_MODE_REAL,positionSide=POSITION_TYPE_BUY;
string server="Venue-Server-1",native="EURUSD.a",response,posted,lastSuccessAction;
double volume=.02,oldSL=1.1,oldTP=1.3;
double mutatedSL=0,mutatedTP=0,tradedLot=0;
int calls=0,selections=0,checks=0;bool exists=true,connected=true;
std::function<void()> pollHook,selectHook;
bool ReadOnlyMode=false,EnableLiveExecution=true,g_maintenanceMode=false,g_closeCommandSupport=true;
bool AllowPositionClose=true,AllowProtectionModify=true,AllowOrderExecution=true;
long lastCommandAt=0;int CommandExpirySeconds=120;string EA_VERSION="fixture";
std::vector<long>seen;
long brokerNow=1000,gmtNow=1000;long TimeCurrent(){return brokerNow;}long TimeGMT(){return gmtNow;}
bool WasCmdSeen(long id){return std::find(seen.begin(),seen.end(),id)!=seen.end();}
void RememberCmd(long id){seen.push_back(id);}
string GetJson(const string&){if(pollHook)pollHook();return response;}
void HandleCommand(const string);
void DispatchReadOnly(long,const string&,const string&){throw std::runtime_error("unexpected readonly action");}
#define UNRELATED_HANDLER(name) void name(long,const string&){throw std::runtime_error("unexpected " #name);}
// Market handler is extracted too for result-evidence tests.
UNRELATED_HANDLER(HandlePlacePending)
UNRELATED_HANDLER(HandleBreakEven)
UNRELATED_HANDLER(HandlePartialClose)
UNRELATED_HANDLER(HandleReverse)
UNRELATED_HANDLER(HandleModifyPending)
UNRELATED_HANDLER(HandleCancelPending)
UNRELATED_HANDLER(HandleCloseAllByMagic)
UNRELATED_HANDLER(HandlePanicCloseAll)
void HandleCloseAll(long,const string&,bool,const string&){throw std::runtime_error("unexpected bulk close");}
void HandleCancelAllPending(long,const string&,bool,const string&){throw std::runtime_error("unexpected bulk cancel");}
string BridgeToken="synthetic-token";double MaxLiveLot=1,g_maxDeviationPoints=20;
#define ARX_LIVE_DEDUP_CAP 64
string g_liveDoneIds[64],g_liveDoneStatus[64],g_liveDoneBody[64];
long g_tradeEvidenceIds[64];string g_tradeEvidenceBodies[64];int g_tradeEvidenceCount=0,g_tradeEvidenceNext=0;int g_liveDoneCount=0,g_liveDoneNext=0;
int StringLen(const string&s){return (int)s.size();}
int StringFind(const string&s,const string&q,int start=0){auto n=s.find(q,start);return n==string::npos?-1:(int)n;}
string StringSubstr(const string&s,int start,int len=-1){return s.substr(start,len<0?string::npos:(size_t)len);}
ushort StringGetCharacter(const string&s,int p){return (unsigned char)s.at(p);}
string ShortToString(ushort c){return string(1,(char)c);}
long StringToInteger(const string&s){try{return std::stol(s);}catch(...){return 0;}}
double StringToDouble(const string&s){try{return std::stod(s);}catch(...){return 0;}}
string IntegerToString(long n){return std::to_string(n);}
bool MathIsValidNumber(double n){return std::isfinite(n);}double MathAbs(double n){return std::abs(n);}
long AccountInfoInteger(int k){return k==ACCOUNT_LOGIN?login:mode;}
string AccountInfoString(int){return server;}long TerminalInfoInteger(int){return connected;}
bool PositionSelectByTicket(ulong t){++selections;if(selectHook)selectHook();return exists&&t==42;}
string PositionGetString(int){return native;}long PositionGetInteger(int){return positionSide;}
double PositionGetDouble(int k){return k==POSITION_VOLUME?volume:k==POSITION_SL?oldSL:oldTP;}
double SymbolInfoDouble(const string&,int){return 1.2;}
const char* formatArg(const string&s){return s.c_str();}template<class T>T formatArg(T v){return v;}
template<class... A>string StringFormat(string fmt,A...args){
 for(auto spec:{string("%I64u"),string("%I64d")})for(size_t p;(p=fmt.find(spec))!=string::npos;)fmt.replace(p,5,spec.back()=='u'?"%lu":"%ld");
 int n=std::snprintf(nullptr,0,fmt.c_str(),formatArg(args)...);if(n<0)throw std::runtime_error("format");
 std::vector<char>b(n+1);std::snprintf(b.data(),b.size(),fmt.c_str(),formatArg(args)...);return string(b.data(),n);
}
template<class...A>void PrintFormat(const string&,A...){}
string JString(const string&s){return "\""+s+"\"";}
bool HttpPost(const string&path,const string&body,string&out,const string&){if(path.find("live-commands-poll")!=string::npos){out=response;if(pollHook)pollHook();}else posted=body;return true;}
void SendAccountSnapshotNow(){}void SyncLivePositionsNow(){}
bool IsCommandTypeAllowedRemotely(const string&){return true;}double EffectiveMaxLiveLot(){return MaxLiveLot;}
bool PreTradeBrokerGuard(const string&,const string&,double,double,double,double,double,string&){return true;}
bool tradeResultOk=true;int resultRetcode=10009;ulong resultDeal=43,resultOrder=42;double resultVolume=.02,resultPrice=1.2;
using ENUM_ORDER_TYPE=int;
struct Preflight{bool ok=true;string resolvedSymbol="EURUSD.a";double ask=1.2,bid=1.19,minVol=.001,maxVol=1,stepVol=.001;long tradeMode=1,fillingMode=1,stopsLevel=0;};
void RunPreflight(const string&,const string&,double,double,double,Preflight&){}
void PostPreflightReject(long,const string&,const string&,const string&,double,const Preflight&){posted="PREFLIGHT_REJECTED";}
string BuildArxComment(const string&){return "ARX-fixture";}string lastErrorSeen;
int GetLastError(){return 0;}
void PostTradeEvidence(const long,const string,const bool,const ulong,const double);
bool ReplayTradeEvidence(const long);
void PostJson(const string&,const string&body){posted=body;}
string JsonEscape(const string&s){return JString(s);}
struct CTrade{
 void SetTypeFillingBySymbol(const string&){}
 void SetDeviationInPoints(double){}bool Buy(double lot,const string&,double,double sl,double tp,const string&){++calls;tradedLot=lot;mutatedSL=sl;mutatedTP=tp;return tradeResultOk;}
 bool Sell(double lot,const string&,double,double sl,double tp,const string&){++calls;tradedLot=lot;mutatedSL=sl;mutatedTP=tp;return tradeResultOk;}
 bool PositionClose(ulong){++calls;return tradeResultOk;}bool PositionModify(ulong,double sl,double tp){++calls;mutatedSL=sl;mutatedTP=tp;return tradeResultOk;}
 ulong ResultOrder(){return resultOrder;}ulong ResultDeal(){return resultDeal;}double ResultPrice(){return resultPrice;}double ResultVolume(){return resultVolume;}
 int ResultRetcode(){return resultRetcode;}string ResultComment(){return "fixture";}
}trade;
void ArmReject(long,const string&,const string&){posted="ARM_REJECTED";}
template<class...A>void PostResultStruct(long,const string&status,const string&reason,A...){posted="{\"status\":"+JString(status)+",\"reason\":"+JString(reason)+"}";}
#include "ArxManagementTarget.mqh"
#include "ArxTradeResult.mqh"
#include "management_wire.inc"
void reset(){brokerNow=gmtNow=1000;tradeResultOk=true;resultRetcode=10009;resultDeal=43;resultOrder=42;resultVolume=.02;resultPrice=1.2;g_tradeEvidenceCount=g_tradeEvidenceNext=0;login=100;mode=ACCOUNT_TRADE_MODE_REAL;server="Venue-Server-1";native="EURUSD.a";volume=.02;oldSL=1.1;oldTP=1.3;positionSide=POSITION_TYPE_BUY;exists=true;connected=true;calls=selections=0;tradedLot=0;pollHook=nullptr;selectHook=nullptr;g_liveDoneCount=g_liveDoneNext=0;posted="";seen.clear();AllowOrderExecution=true;ReadOnlyMode=false;EnableLiveExecution=true;AllowPositionClose=AllowProtectionModify=true;}
string target(bool modify=false){return string("{\"version\":1,\"accountLogin\":\"100\",\"observedServerName\":\"Venue-Server-1\",\"brokerTicket\":\"42\",\"symbol\":\"EURUSD.a\",\"side\":\"BUY\",\"volume\":0.02,\"currentStopLoss\":1.1,\"currentTakeProfit\":1.3,\"nextStopLoss\":1.2,\"action\":\"")+(modify?"TIGHTEN_SL":"EXIT")+"\"}";}
string wire(bool live,bool modify=false,bool bound=true){return string("{\"id\":1,\"action\":\"")+(modify?"MODIFY_POSITION":"CLOSE_POSITION")+"\",\"commandId\":\"command-1\",\"commandType\":\""+(modify?"MODIFY_LIVE_SLTP":"CLOSE_LIVE_POSITION")+"\",\"symbol\":\"EURUSD.a\",\"side\":\"BUY\",\"requestedVolume\":0.02,\"stopLoss\":1.2,\"takeProfit\":1.3,\"sl\":1.2,\"tp\":1.3,\"positionTicket\":\"42\",\"secondsUntilExpiry\":30,\"payload\":{\"brokerTicket\":\"42\""+(bound?",\"managementTargetV1\":"+target(modify):"")+"}}"+(live?"":"");}
void run(bool live,const string&w,bool modify=false){if(live){response="{\"command\":"+w+"}";PollAndExecuteLiveCommands();}else {response="{\"commands\":["+w+"]}";PollAndExecute();}(void)modify;}
void check(bool ok,const string&what){++checks;if(!ok)throw std::runtime_error(what+" calls="+std::to_string(calls)+" report="+posted);}
string replace(string s,const string&a,const string&b){auto p=s.find(a);if(p==string::npos)throw std::runtime_error("fixture missing");s.replace(p,a.size(),b);return s;}
int main(int argc,char**argv){
 if(argc==3&&string(argv[1])=="--wire-file"){
  std::ifstream file(argv[2]);std::stringstream contents;contents<<file.rdbuf();reset();response=contents.str();
  if(response.empty())throw std::runtime_error("empty wire fixture");
  PollAndExecute();check(calls==1,"actual PostgreSQL mirror response reaches terminal mutation");
  check(mutatedSL==1.123456789&&mutatedTP==1.3,"authoritative full precision preserved to CTrade arguments");
  std::cout<<checks<<" real route-to-extracted-EA checks passed\n";return 0;
 }
 if(argc>1){
  for(bool live:{false,true})for(bool modify:{false,true}){
   auto w=wire(live,modify);std::vector<double>times;
   for(int i=0;i<1100;i++){reset();auto start=std::chrono::steady_clock::now();run(live,w,modify);auto end=std::chrono::steady_clock::now();if(calls!=1)throw std::runtime_error("benchmark incomplete");if(i>=100)times.push_back(std::chrono::duration<double,std::micro>(end-start).count());}
   auto raw=times;std::sort(times.begin(),times.end());std::cout<<"{\"baseline\":"<<ARX_BASELINE<<",\"path\":\""<<(live?"live":"legacy")<<"\",\"action\":\""<<(modify?"modify":"close")<<"\",\"unit\":\"microseconds\",\"samples\":1000,\"median\":"<<times[499]<<",\"p95\":"<<times[949]<<",\"p99\":"<<times[989]<<",\"max\":"<<times.back()<<",\"rawMicroseconds\":[";for(size_t i=0;i<raw.size();i++)std::cout<<(i?",":"")<<raw[i];std::cout<<"]}\n";
  }
  return 0;
 }
 for(bool live:{false,true})for(bool modify:{false,true}){
  auto w=wire(live,modify);reset();run(live,w,modify);check(calls==1,"matching native target passes");
  reset();login=200;run(live,w,modify);check(calls==(ARX_BASELINE?1:0),"wrong account reused ticket");
  reset();server="Other-Server";run(live,w,modify);check(calls==(ARX_BASELINE?1:0),"same login wrong actual server");
  reset();native="EURUSD";run(live,w,modify);check(calls==(ARX_BASELINE?1:0),"canonical/native mismatch");
  reset();volume=.03;run(live,w,modify);check(calls==(ARX_BASELINE?1:0),"changed volume");
  reset();positionSide=POSITION_TYPE_SELL;run(live,w,modify);check(calls==(ARX_BASELINE?1:0),"changed side");
  reset();oldSL=1.15;run(live,w,modify);check(calls==(ARX_BASELINE?1:0),"changed protection");
  reset();run(live,wire(live,modify,false),modify);check(calls==1,"ordinary manual protection preserved");
  reset();login=200;run(live,wire(live,modify,false),modify);check(calls==1,"manual path not silently account-bound");
  if(!ARX_BASELINE){
   for(auto bad:{replace(w,"\"version\":1","\"version\":2"),replace(w,"\"accountLogin\":\"100\"","\"accountLogin\":\"100\",\"accountLogin\":\"200\""),replace(w,"\"volume\":0.02","\"volume\":1e999"),replace(w,target(modify),"null"),replace(w,"managementTargetV1","agentOwnership")}){reset();run(live,bad,modify);check(calls==0,"malformed/partial attribution refuses");}
   reset();volume=.02000000001;run(live,w,modify);check(calls==0,"no tolerance silently widens volume");
   reset();selectHook=[](){login=200;};run(live,w,modify);check(calls==0,"account switch during fresh selection");
   reset();selectHook=[](){server="Changed-Server";};run(live,w,modify);check(calls==0,"server switch during selection");
   reset();pollHook=[](){mode=ACCOUNT_TRADE_MODE_DEMO;};run(live,w,modify);check(calls==0,"REAL-to-DEMO switch during poll");
   reset();login=9223372036854775807L;run(live,replace(w,"\"accountLogin\":\"100\"","\"accountLogin\":\"9223372036854775807\""),modify);check(calls==1,"19-digit login preserved exactly through wire");
   reset();run(live,w,modify);run(live,w,modify);check(calls==1,"existing in-process duplicate refusal preserved");
   reset();exists=false;run(live,w,modify);check(calls==0,"missing position");
   reset();run(live,replace(w,"\"symbol\":\"EURUSD.a\"","\"symbol\":\"EURUSD.a\",\"symbol\":\"GBPUSD\""),modify);check(calls==0,"duplicate direct symbol refuses");
   if(modify){reset();run(live,replace(w,"\"nextStopLoss\":1.2","\"nextStopLoss\":1.25"),modify);check(calls==0,"requested stop must match target");}
  }
  reset();pollHook=[](){login=200;};run(live,w,modify);check(calls==(ARX_BASELINE?1:0),"account switches during poll");
 }
 if(!ARX_BASELINE){
  check(ArxPositiveDecimal("9223372036854775807"),"full positive signed-long range accepted");
  check(!ArxPositiveDecimal("9223372036854775808"),"signed-long overflow refused");
  check(!ArxPositiveDecimal("18446744073709551615"),"unsigned-only ticket remains unsupported explicitly");
  reset();response="  {\"commands\":["+wire(false)+"]} \n\t";PollAndExecute();check(calls==1,"outer trailing whitespace is valid JSON");
  reset();response="{\"commands\":["+wire(false)+"]} trailing";PollAndExecute();check(calls==0,"trailing junk refused before mutation");
  reset();response="{\"commands\":["+wire(false)+",42]}";PollAndExecute();check(calls==0,"whole batch validated before first mutation");
  reset();auto nested=replace(wire(false),"\"payload\":{","\"payload\":{\"irrelevant\":[{\"id\":91},{\"id\":92}],");run(false,nested);check(calls==1,"nested objects are not command boundaries");
  reset();auto second=replace(wire(false),"\"id\":1,","\"id\":2,");response="{\"commands\":["+wire(false)+","+second+"]}";PollAndExecute();check(calls==2,"two whole command objects preserved");
  reset();response="{\"commands\":[";for(int i=0;i<51;i++)response+=(i?",":"")+wire(false);response+="]}";PollAndExecute();check(calls==0,"oversized batch refuses before first command");
  reset();ReadOnlyMode=true;run(false,wire(false));check(calls==0,"legacy readonly arm preserved");
  reset();AllowOrderExecution=false;run(false,wire(false));check(calls==0,"legacy execution arm preserved");
 }
 std::cout<<checks<<" actual-handler checks passed; baseline="<<ARX_BASELINE<<" (no terminal/broker I/O)\n";
 return 0;
}
