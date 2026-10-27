#define main target_checks_main
#include "management_target_test.cpp"
#undef main
#include <limits>
string entryWire(const string&extra=""){return "{\"id\":1,"+extra+"\"action\":\"OPEN_MARKET\",\"commandId\":\"entry-1\",\"commandType\":\"PLACE_LIVE_MARKET_ORDER\",\"symbol\":\"EURUSD.a\",\"side\":\"BUY\",\"lot\":0.02,\"requestedVolume\":0.02,\"secondsUntilExpiry\":30,\"confirmedByUser\":true,\"payload\":{}}";}
void runResult(bool live,const string&kind){
 if(kind=="ENTRY") {if(live){response="{\"command\":"+entryWire()+"}";PollAndExecuteLiveCommands();}else {response="{\"commands\":["+entryWire()+"]}";PollAndExecute();}}
 else run(live,wire(live,kind=="MODIFY"),kind=="MODIFY");
}
string actualStatus(bool live){(void)live;return JsonReadString(posted,"status");}
void field(const string&key,const string&expected){string raw;bool found=false;check(ArxJsonMember(posted,key,raw,found)&&found&&raw==expected,key+"="+expected+" got="+raw);}
int main(int argc,char**argv){
 if(argc==3&&string(argv[1])=="--entry-wire-file"){
  // Actual PostgreSQL poll response -> extracted v154 entry handler. The fake
  // broker fills its own exact step volume (0.02); the posted body is printed
  // for the actual server result route. No terminal/broker/network I/O.
  std::ifstream file(argv[2]);std::stringstream contents;contents<<file.rdbuf();reset();response=contents.str();
  if(response.empty())throw std::runtime_error("empty entry wire fixture");
  resultVolume=.02;resultPrice=1.234567891;
  PollAndExecute();check(calls==1,"actual PostgreSQL entry mirror reaches CTrade");
  std::cout<<"{\"tradedLot\":"<<ArxResultNumber(tradedLot)<<",\"tradedSL\":"<<ArxResultNumber(mutatedSL)<<",\"tradedTP\":"<<ArxResultNumber(mutatedTP)<<",\"body\":"<<posted<<"}\n";return 0;
 }
 bool emit=argc>1&&string(argv[1])=="--emit";
 // Mailbox expiry compares the server's UTC createdAtEpoch with the terminal
 // clock. A UTC+3 broker must not expire a 10 s old command; a 200 s old one
 // must expire everywhere. Baseline source used broker time and got both wrong.
 reset();gmtNow=1000;brokerNow=1000+10800;response="{\"commands\":["+entryWire("\"createdAtEpoch\":990,")+"]}";PollAndExecute();
 check(calls==(ARX_BASELINE?0:1),"fresh command on a UTC+3 broker clock is executed, not expired");
 if(ARX_BASELINE)check(JsonReadString(posted,"status")=="EXPIRED","baseline expires fresh commands on offset broker clocks");
 reset();gmtNow=1000;brokerNow=1000-10800;response="{\"commands\":["+entryWire("\"createdAtEpoch\":800,")+"]}";PollAndExecute();
 if(ARX_BASELINE)check(calls==1,"baseline never expires commands when the broker clock lags UTC");
 else check(calls==0&&JsonReadString(posted,"status")=="EXPIRED","stale command expires even when the broker clock lags UTC "+posted);
 struct Scenario{const char*name;bool ok;int code;ulong deal;double vol,price;const char*expected;};
 const Scenario cases[]={
  {"full",true,10009,43,.02,1.234567891,"LIVE_FILLED"},
  {"partial",true,10010,43,.00789123,1.234567891,"LIVE_PARTIALLY_FILLED"},
  {"short_done",true,10009,43,.00789123,1.234567891,"LIVE_PARTIALLY_FILLED"},
  {"accepted",true,10008,0,.02,0,"LIVE_ACKNOWLEDGED"},
  {"missing_deal",true,10009,0,.02,1.2,"LIVE_UNKNOWN"},
  {"missing_volume",true,10009,43,0,1.2,"LIVE_UNKNOWN"},
  {"missing_price",true,10009,43,.02,0,"LIVE_UNKNOWN"},
  {"timeout",true,10012,0,0,0,"LIVE_UNKNOWN"},
  {"connection",false,10031,0,0,0,"LIVE_UNKNOWN"},
  {"call_false_done",false,10009,43,.02,1.2,"LIVE_UNKNOWN"},
  {"rejected",true,10006,0,0,0,"LIVE_REJECTED"},
  {"contradictory_reject",true,10006,43,.02,1.2,"LIVE_UNKNOWN"},
  {"overfill",true,10009,43,.03,1.2,"LIVE_UNKNOWN"},
  {"no_changes",true,10025,0,0,0,"LIVE_UNKNOWN"},
  {"partial_equal",true,10010,43,.02,1.2,"LIVE_PARTIALLY_FILLED"},
  {"nan_volume",true,10009,43,std::numeric_limits<double>::quiet_NaN(),1.2,"LIVE_UNKNOWN"},
 };
 for(bool live:{false,true})for(const string kind:{"ENTRY","CLOSE","MODIFY"})for(const auto&c:cases){
  reset();tradeResultOk=c.ok;resultRetcode=c.code;resultDeal=c.deal;resultVolume=c.vol;resultPrice=c.price;
  if(kind=="MODIFY"&&string(c.name)=="full"){resultDeal=0;resultVolume=0;resultPrice=0;}
  runResult(live,kind);check(calls==1,"one attempted trade call");
  if(emit){std::cout<<"{\"path\":\""<<(live?"live":"legacy")<<"\",\"kind\":\""<<kind<<"\",\"scenario\":\""<<c.name<<"\",\"body\":"<<posted<<"}\n";continue;}
  if(ARX_BASELINE){check(actualStatus(live)==(live?(c.ok?"LIVE_FILLED":"LIVE_REJECTED"):(c.ok&&c.code==10009?(kind=="ENTRY"?"FILLED":kind=="CLOSE"?"CLOSED":"MODIFIED"):"REJECTED")),"baseline actual behavior");continue;}
  string expected=c.expected;
  if(kind=="MODIFY" && string(c.name)!="full" && string(c.name)!="accepted" && string(c.name)!="rejected")expected="LIVE_UNKNOWN";
  check(actualStatus(live)==expected,"evidence outcome "+kind+" "+c.name+" expected "+expected);
  bool fill=kind!="MODIFY"&&(expected=="LIVE_FILLED"||expected=="LIVE_PARTIALLY_FILLED");
  field("executedVolume",fill?ArxResultNumber(c.vol):"null");field("fillPrice",fill?ArxResultNumber(c.price):"null");field("resultEvidenceVersion","1");
  {auto first=posted;runResult(live,kind);check(calls==1,"duplicate does not call trade");check(posted==first,"duplicate replays complete exact evidence");}
 }
 if(!emit)std::cout<<checks<<" terminal result checks passed baseline="<<ARX_BASELINE<<"; no broker/terminal I/O\n";
}
