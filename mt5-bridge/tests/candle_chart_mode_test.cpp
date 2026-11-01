// Actual extracted producer functions; deterministic fake terminal and HTTP sinks.
#include <string>
#include <vector>
#include <map>
#include <iostream>
#include <stdexcept>
#include <sstream>
#include <iomanip>
#include <type_traits>
struct string:std::string {
 using std::string::string;string(const std::string& s):std::string(s){}
 template<class T,typename std::enable_if<std::is_arithmetic<T>::value,int>::type=0>explicit string(T x):std::string(std::to_string(x)){}
};
using datetime=long;using ENUM_TIMEFRAMES=int;
enum {SYMBOL_CHART_MODE,SYMBOL_DIGITS,SERIES_FIRSTDATE,ACCOUNT_LOGIN};
enum {SYMBOL_CHART_MODE_BID=0,SYMBOL_CHART_MODE_LAST=1};
struct MqlRates{long time=1200;double open=1.2,high=1.3,low=1.1,close=1.25;long tick_volume=17;};
struct Observation{bool ok;long mode;};
std::map<std::string,std::vector<Observation>> modes;std::map<std::string,size_t> query;
std::vector<string> posted;std::vector<string> events;int copies=0;bool failCopy=false;bool walk=false;
enum {V2_STREAM_CAPACITY=10};int v2BarCount=0;string v2BarKeys[10];long v2BarLastOpen[10];
int CandleLiveBatchBars=1,CandleBackfillBatchBars=1,CandleBackfillPagesPerCycle=1;
string EA_VERSION="offline-fixture";
bool SymbolInfoInteger(const string& sym,int property,long& value){
 if(property!=SYMBOL_CHART_MODE)throw std::runtime_error("wrong chart-mode property");
 events.push_back("mode:"+sym);auto &v=modes.at(sym);auto i=query[sym]++;auto observation=v.at(i<v.size()?i:v.size()-1);
 // Failed reads deliberately leave the output at zero (which numerically equals BID).
 value=observation.ok?observation.mode:0;return observation.ok;
}
long SymbolInfoInteger(const string&,int property){if(property!=SYMBOL_DIGITS)throw std::runtime_error("unsafe immediate chart-mode read");return 5;}
long SeriesInfoInteger(const string&,int,int){return 1;}
long AccountInfoInteger(int){return 1234;}long TimeCurrent(){return 1400;}long TimeGMT(){return 1300;}
int CopyRates(const string& sym,int,long,long,std::vector<MqlRates>& out){
 if(sym!="EURUSD.a"&&sym!="EXCHANGE.b")throw std::runtime_error("wrong CopyRates symbol");
 events.push_back("rates:"+sym);++copies;if(failCopy)return -1;out={MqlRates{}};return 1;
}
string SafeF(double v,int digits){std::ostringstream s;s<<std::fixed<<std::setprecision(digits)<<v;return s.str();}
string StringSubstr(const string&s,int start,int length){return s.substr(start,length);}
int StringLen(const string&s){return int(s.size());}void StringToUpper(string&){}
int CandleTfEnum(const string&){return 1;}int CandleTfSeconds(const string&){return 60;}
long CandleIsoToTime(const string&){return 1100;}string TimeframeName(int){return "M1";}
string JsonStr(const string&r,const string&key){return key=="status"?(r=="more"?"NEED_MORE":"COMPLETE"):"cursor";}
string PostJsonGetBody(const string&path,const string&body){if(path!="/api/mt5/candles/ingest")throw std::runtime_error("transport changed");posted.push_back(body);return walk&&posted.size()==1?"more":"complete";}
bool PostV2Ingest(const string&type,const string&key,const string&body){if(type!="CANDLE"||key.find("|M1")==string::npos)throw std::runtime_error("stream scoping changed");posted.push_back(body);return true;}
void PostV2(const string&t,const string&k,const string&b){PostV2Ingest(t,k,b);}
#include "candle_mode_wire.inc"
void reset(){events.clear();posted.clear();modes.clear();query.clear();v2BarCount=0;copies=0;failCopy=false;walk=false;}
void emit(const string&scenario,const string&sym,const string&expect,const string&body){std::cout<<"{\"scenario\":\""<<scenario<<"\",\"symbol\":\""<<sym<<"\",\"expect\":"<<(expect.empty()?"null":"\""+expect+"\"")<<",\"body\":"<<body<<"}\n";}
void run(bool stream,const string&sym){
 (void)stream;
#if UNIVERSAL
 if(!stream){ProcessCandleSeries(sym,"M1");return;}
#endif
#if STREAM
#if UNIVERSAL
 PushLiveCandleV2(sym,"M1",1);
#else
 PushClosedCandle(sym,1);
#endif
#else
 (void)stream;(void)sym;
#endif
}
int main(){
 for(bool stream:{false,true}){
#if !UNIVERSAL
 if(!stream)continue;
#endif
#if !STREAM
 if(stream)continue;
#endif
 struct Case{string name,expected;std::vector<Observation> observations;};
 std::vector<Case> cases={{"bid","bid",{{true,0},{true,0}}},{"last","last",{{true,1},{true,1}}},{"failed-before","",{{false,0},{true,0}}},{"failed-after","",{{true,0},{false,0}}},{"unsupported","",{{true,99},{true,99}}},{"changed","",{{true,0},{true,1}}},{"changed-reverse","",{{true,1},{true,0}}}};
 for(const auto&c:cases){reset();modes["EURUSD.a"]=c.observations;run(stream,"EURUSD.a");if(posted.size()!=1)throw std::runtime_error("missing payload");if(events!=std::vector<string>{"mode:EURUSD.a","rates:EURUSD.a","mode:EURUSD.a"})throw std::runtime_error("chart mode must bracket same-symbol CopyRates");emit(c.name+(stream?"-stream":"-batch"),"EURUSD.a",c.expected,posted[0]);}
 reset();modes["EURUSD.a"]={{true,0}};modes["EXCHANGE.b"]={{true,1}};run(stream,"EURUSD.a");run(stream,"EXCHANGE.b");if(posted.size()!=2)throw std::runtime_error("mixed symbols lost");emit("mixed-bid","EURUSD.a","bid",posted[0]);emit("mixed-last","EXCHANGE.b","last",posted[1]);
 reset();failCopy=true;modes["EURUSD.a"]={{true,0}};run(stream,"EURUSD.a");if(!posted.empty())throw std::runtime_error("failed CopyRates published bars");
 }
#if UNIVERSAL
 reset();walk=true;modes["EURUSD.a"]={{true,0},{true,0},{true,1},{true,1}};run(false,"EURUSD.a");if(posted.size()!=2||copies!=2)throw std::runtime_error("backfill not covered");emit("live-before-backfill","EURUSD.a","bid",posted[0]);emit("separate-backfill-mode","EURUSD.a","last",posted[1]);
#endif
}
