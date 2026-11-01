#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <cstdio>
#include <iostream>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>
#include <string>
#include <vector>
#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#else
#include <openssl/sha.h>
#endif
using string=std::string;using ulong=unsigned long;using ushort=unsigned short;using uchar=unsigned char;using ENUM_ACCOUNT_INFO_DOUBLE=int;
static_assert(sizeof(ulong)==8,"MQL ulong must remain64bit");
constexpr int CP_UTF8=65001,WHOLE_ARRAY=-1,CRYPT_HASH_SHA256=1;
enum{ACCOUNT_LOGIN,ACCOUNT_CURRENCY_DIGITS,ACCOUNT_SERVER,ACCOUNT_CURRENCY,TERMINAL_CONNECTED,ACCOUNT_BALANCE,ACCOUNT_EQUITY,ACCOUNT_PROFIT,ACCOUNT_CREDIT,ACCOUNT_MARGIN,ACCOUNT_MARGIN_FREE};
struct MqlTradeTransaction{long magic=999;};struct MqlTradeRequest{long magic=999;};struct MqlTradeResult{};
ulong elapsed=0,captureStep=0;long utc=1800000000,login=123456789,digits=2;int error=0,failProperty=-1,moneyReads=0;bool connected=true,switchIdentity=false,cryptoFailure=false,encodingFailure=false,disconnectAfter=false,changeCurrency=false,changeDigits=false;
string server="Broker-é",currency="USD",BridgeBaseUrl="https://offline.invalid",BridgeToken="fake-test-only",EA_VERSION="1.54";
double amounts[6]={1000.125,1055.375,12.345,43.03,10.0,-2.125};
int httpCode=200,ackMode=0,timeoutSeen=0,requests=0,diagnostics=0;bool transactionDuringRequest=false;string responseOverride;std::vector<string> bodies;
void ResetLastError(){error=0;}int GetLastError(){return error;}ulong GetTickCount64(){return elapsed;}ulong GetMicrosecondCount(){return elapsed*1000+17;}long TimeGMT(){return utc;}long ChartID(){return 7744;}
long AccountInfoInteger(int property){if(property==failProperty)error=500;return property==ACCOUNT_LOGIN?login:digits+(changeDigits&&moneyReads>0?1:0);}
string AccountInfoString(int property){if(property==failProperty)error=500;return property==ACCOUNT_SERVER?server+(switchIdentity&&moneyReads>0?"-changed":""):currency+(changeCurrency&&moneyReads>0?"X":"");}
long TerminalInfoInteger(int property){if(property==failProperty)error=500;return connected&&!(disconnectAfter&&moneyReads>0);}
double AccountInfoDouble(int property){moneyReads++;elapsed+=captureStep;if(property==failProperty)error=500;return amounts[property-ACCOUNT_BALANCE];}
// Terminal strings index UTF-16 code units; JSON/transport remains UTF-8.
std::u16string utf16(const string&s){
 std::u16string out;size_t i=0;
 while(i<s.size()){
  uint32_t c=static_cast<unsigned char>(s[i++]);int rest=0;
  if(c<128){}else if((c&0xe0)==0xc0){c&=31;rest=1;}else if((c&0xf0)==0xe0){c&=15;rest=2;}else if((c&0xf8)==0xf0){c&=7;rest=3;}else throw std::runtime_error("bad UTF8");
  for(int n=0;n<rest;n++){if(i>=s.size())throw std::runtime_error("short UTF8");uint32_t next=static_cast<unsigned char>(s[i++]);if((next&0xc0)!=0x80)throw std::runtime_error("bad UTF8 continuation");c=(c<<6)|(next&63);}
  if(c>0x10ffff)throw std::runtime_error("bad Unicode");
  if(c<=0xffff)out.push_back(static_cast<char16_t>(c));else{c-=0x10000;out.push_back(static_cast<char16_t>(0xd800+(c>>10)));out.push_back(static_cast<char16_t>(0xdc00+(c&1023)));}
 }
 return out;
}
string utf8(const std::u16string&s){
 string out;for(size_t i=0;i<s.size();i++){
  uint32_t c=s[i];if(c>=0xd800&&c<=0xdbff){if(i+1>=s.size()||s[i+1]<0xdc00||s[i+1]>0xdfff)throw std::runtime_error("broken surrogate");c=0x10000+((c-0xd800)<<10)+(s[++i]-0xdc00);}
  if(c<128)out.push_back(static_cast<char>(c));else if(c<2048){out.push_back(static_cast<char>(0xc0|(c>>6)));out.push_back(static_cast<char>(0x80|(c&63)));}else if(c<65536){out.push_back(static_cast<char>(0xe0|(c>>12)));out.push_back(static_cast<char>(0x80|((c>>6)&63)));out.push_back(static_cast<char>(0x80|(c&63)));}else{out.push_back(static_cast<char>(0xf0|(c>>18)));out.push_back(static_cast<char>(0x80|((c>>12)&63)));out.push_back(static_cast<char>(0x80|((c>>6)&63)));out.push_back(static_cast<char>(0x80|(c&63)));}
 }
 return out;
}
bool MathIsValidNumber(double v){return std::isfinite(v);}int MathMax(int a,int b){return std::max(a,b);}int StringLen(const string&s){return static_cast<int>(utf16(s).size());}
ushort StringGetCharacter(const string&s,int i){auto u=utf16(s);return i>=0&&i<static_cast<int>(u.size())?u[i]:0;}
int StringFind(const string&s,const string&v){auto p=utf16(s).find(utf16(v));return p==std::u16string::npos?-1:static_cast<int>(p);}
string StringSubstr(const string&s,int p,int n=-1){auto u=utf16(s);return p>=static_cast<int>(u.size())?"":utf8(u.substr(p,n<0?std::u16string::npos:static_cast<size_t>(n)));}
void StringReplace(string&s,const string&from,const string&to){size_t p=0;while((p=s.find(from,p))!=string::npos){s.replace(p,from.size(),to);p+=to.size();}}
string DoubleToString(double v,int d){std::ostringstream s;s.imbue(std::locale::classic());s<<std::fixed<<std::setprecision(d)<<v;return s.str();}
string StringFormat(const char*format,unsigned char n){char out[20];std::snprintf(out,sizeof(out),format,n);return out;}
template<class T>int ArrayResize(std::vector<T>&a,int n){a.resize(n);return n;}template<class T>int ArraySize(const std::vector<T>&a){return static_cast<int>(a.size());}
template<class T>int StringToCharArray(const string&s,std::vector<T>&a,int,int,int cp){if(encodingFailure){error=500;return 0;}if(cp!=CP_UTF8){error=501;return 0;}a.assign(s.begin(),s.end());a.push_back(0);return static_cast<int>(a.size());}
string CharArrayToString(const std::vector<char>&a,int,int,int){return string(a.begin(),a.end());}
int CryptEncode(int method,const std::vector<uchar>&data,const std::vector<uchar>&key,std::vector<uchar>&out){if(cryptoFailure||method!=CRYPT_HASH_SHA256||!key.empty())return 0;out.resize(32);
#ifdef __APPLE__
 CC_SHA256(data.data(),static_cast<CC_LONG>(data.size()),out.data());
#else
 SHA256(data.data(),data.size(),out.data());
#endif
 return 32;}

void Print(const string&){diagnostics++;}
int WebRequest(const string&,const string&,const string&,int,std::vector<char>&,std::vector<char>&,string&);
#include "native_account_wire.inc"
int checks=0,failures=0;void check(bool ok,const char*label){checks++;if(!ok){failures++;std::cerr<<"FAIL "<<label<<'\n';}}
string ack(bool duplicate=false){string seq;NativeJsonField(nativeAccountEnvelope,"sequence",seq);return "{\"ok\":true,\"received\":1,\"accepted\":"+string(duplicate?"0":"1")+",\"results\":[{\"accepted\":"+string(duplicate?"false":"true")+",\"outcome\":\""+string(duplicate?"DUPLICATE":"ACCEPTED")+"\",\"exactReplay\":"+string(duplicate?"true":"false")+",\"messageType\":\"ACCOUNT_SNAPSHOT\",\"streamKey\":\"ACCOUNT_NATIVE_V1\",\"sequence\":"+seq+",\"idempotencyKey\":"+JsonEscape(nativeAccountIdempotency)+"}]}";}
int WebRequest(const string&method,const string&url,const string&headers,int timeout,std::vector<char>&post,std::vector<char>&result,string&){requests++;timeoutSeen=timeout;bodies.emplace_back(post.begin(),post.end());check(method=="POST"&&url==BridgeBaseUrl+"/api/bridge/v2/ingest","existing endpoint");check(headers.find("X-MT5-Bridge-Token: fake-test-only")!=string::npos,"existing auth header");if(transactionDuringRequest)OnTradeTransaction({}, {}, {});string response=responseOverride.empty()?(ackMode==1?ack(true):ackMode==2?"{}":ack()):responseOverride;result.assign(response.begin(),response.end());return httpCode;}
void reset(){elapsed=0;captureStep=0;utc=1800000000;login=123456789;digits=2;error=0;failProperty=-1;moneyReads=0;connected=true;switchIdentity=false;cryptoFailure=false;encodingFailure=false;disconnectAfter=false;changeCurrency=changeDigits=false;server="Broker-é";currency="USD";double initial[]={1000.125,1055.375,12.345,43.03,10,-2.125};std::copy(initial,initial+6,amounts);httpCode=200;ackMode=0;timeoutSeen=requests=diagnostics=0;v2SeqCount=0;std::fill(std::begin(v2SeqKeys),std::end(v2SeqKeys),"");std::fill(std::begin(v2SeqNext),std::end(v2SeqNext),0);transactionDuringRequest=false;responseOverride="";bodies.clear();nativeAccountInstance="";nativeAccountEnvelope="";nativeAccountIdempotency="";nativeAccountPendingBinding="";nativeAccountPendingFingerprint=nativeAccountAcknowledgedFingerprint="";nativeAccountLastAcknowledgedMs=0;nativeAccountHasAcknowledgement=false;nativeAccountLastAttemptMs=nativeAccountQueuedAtMs=0;nativeAccountAttempted=false;nativeAccountDirty=true;nativeAccountAttempts=0;nativeAccountDirtyGeneration=nativeAccountCapturedGeneration=nativeAccountReportCounter=0;NativeAccountIntervalSeconds=1;BridgeToken="fake-test-only";BridgeBaseUrl="https://offline.invalid";}
int main(){
 string p,b,f;
 reset();for(int symbol=0;symbol<V2_MAX_LIVE_SYMBOLS;symbol++){for(int tf=0;tf<V2_MAX_LIVE_TFS;tf++)V2NextSequence("CANDLE",std::to_string(symbol)+"|"+std::to_string(tf));V2NextSequence("TICK",std::to_string(symbol));}
 check(QueueNativeAccountReport(),"reserved native sequence slot survives maximum market streams");check(V2NextSequence("ACCOUNT_SNAPSHOT","ACCOUNT_NATIVE_V1")==1,"native sequence advances independently after market capacity");
 check(V2NextSequence("CANDLE","0|0")==1,"existing market sequence unchanged");

 for(int d:{0,2,3,16}){reset();digits=d;check(CaptureNativeAccountReport(p,b,f),"capture requested native precision");std::cout<<"{\"digits\":"<<d<<",\"payload\":"<<p<<"}\n";}
 for(int property:{ACCOUNT_LOGIN,ACCOUNT_SERVER,ACCOUNT_CURRENCY_DIGITS,ACCOUNT_CURRENCY,TERMINAL_CONNECTED,ACCOUNT_BALANCE,ACCOUNT_EQUITY,ACCOUNT_PROFIT,ACCOUNT_CREDIT,ACCOUNT_MARGIN,ACCOUNT_MARGIN_FREE}){reset();failProperty=property;check(!CaptureNativeAccountReport(p,b,f),"property error cannot become data");check(p.empty(),"failed capture has no payload");}
 for(int d:{-1,17}){reset();digits=d;check(!CaptureNativeAccountReport(p,b,f),"unsupported currency precision refused");}
 for(string c:{string(""),string("   "),string("123456789"),string("US\nD"),string("\xc2\xa0"),string("\xe3\x80\x80")}){reset();currency=c;check(!CaptureNativeAccountReport(p,b,f),"missing or invalid currency refused");}
 reset();currency=" A€ ";check(CaptureNativeAccountReport(p,b,f),"visible Unicode/space currency preserved");string currencyValue;NativeJsonField(p,"currency",currencyValue);check(currencyValue==JsonEscape(currency),"currency never normalized");
 reset();currency="😀😀😀😀";check(CaptureNativeAccountReport(p,b,f),"eight UTF16 units allowed");currency+="x";check(!CaptureNativeAccountReport(p,b,f),"nine UTF16 units refused");
 reset();connected=false;check(!CaptureNativeAccountReport(p,b,f),"disconnected capture refused");
 reset();disconnectAfter=true;check(!CaptureNativeAccountReport(p,b,f),"disconnect during capture refused");
 reset();changeCurrency=true;check(!CaptureNativeAccountReport(p,b,f),"currency change during capture refused");
 reset();changeDigits=true;check(!CaptureNativeAccountReport(p,b,f),"precision change during capture refused");
 reset();switchIdentity=true;check(!CaptureNativeAccountReport(p,b,f),"identity switch during capture refused");
 reset();login=0;check(!CaptureNativeAccountReport(p,b,f),"missing account refused");
 reset();utc=0;check(!CaptureNativeAccountReport(p,b,f),"UTC absent cannot use broker clock fallback");
 reset();captureStep=834;check(!CaptureNativeAccountReport(p,b,f),"capture longer than five seconds refused");
 reset();cryptoFailure=true;check(!CaptureNativeAccountReport(p,b,f),"failed hash refused");
 reset();encodingFailure=true;check(!CaptureNativeAccountReport(p,b,f),"failed UTF8 conversion refused");
 for(double bad:{std::numeric_limits<double>::infinity(),-std::numeric_limits<double>::infinity(),std::numeric_limits<double>::quiet_NaN(),1e100}){reset();amounts[0]=bad;check(!CaptureNativeAccountReport(p,b,f),"invalid or overlong money refused");}
 reset();amounts[4]=-1;check(!CaptureNativeAccountReport(p,b,f),"negative used margin refused");
 reset();amounts[2]=-0.0;check(CaptureNativeAccountReport(p,b,f),"negative zero captured");string val;NativeJsonField(p,"profit",val);check(val=="\"0.00\"","negative zero normalized");
 reset();digits=4;amounts[2]=0.0001;check(CaptureNativeAccountReport(p,b,f),"subcent captured");NativeJsonField(p,"profit",val);check(val=="\"0.0001\"","subcent preserved");
 reset();PumpNativeAccountReport();check(requests==1&&timeoutSeen==1000,"bounded initial request");check(nativeAccountEnvelope.empty()&&!nativeAccountDirty,"matching ACK retires report");elapsed=999;PumpNativeAccountReport();check(requests==1,"monotonic throttle");elapsed=1000;PumpNativeAccountReport();check(requests==1,"unchanged ACKed values suppress per-second writes");amounts[2]=99;elapsed=2000;PumpNativeAccountReport();check(requests==2,"changed native profit sent next monotonic timer without quotes");elapsed=16999;PumpNativeAccountReport();check(requests==2,"unchanged values wait for15skeepalive");elapsed=18000;PumpNativeAccountReport();check(requests==3,"unchanged report keepalive after15s");OnTradeTransaction({999},{999},{});elapsed=19000;PumpNativeAccountReport();check(requests==4,"external transaction forces unchanged-value report");
 reset();nativeAccountDirty=false;OnTradeTransaction({999},{999},{});check(nativeAccountDirty&&nativeAccountDirtyGeneration==1&&requests==0,"external transaction only marks dirty");
 reset();transactionDuringRequest=true;PumpNativeAccountReport();check(nativeAccountDirty,"older capture ACK cannot clear newer dirty generation");
 reset();ackMode=2;PumpNativeAccountReport();string original=bodies.back();check(!nativeAccountEnvelope.empty()&&nativeAccountDirty,"malformed200 holds pending");amounts[0]=999;elapsed=1000;PumpNativeAccountReport();check(bodies.back()==original,"retry body immutable despite new values");elapsed=2000;PumpNativeAccountReport();check(bodies.back()==original,"third attempt same body");elapsed=3000;PumpNativeAccountReport();check(bodies.back()!=original&&diagnostics==1,"bounded old failure replaced by newest report");
 reset();ackMode=2;PumpNativeAccountReport();original=bodies.back();elapsed=5000;PumpNativeAccountReport();check(bodies.back()!=original,"old pending expires after5s");
 reset();ackMode=2;PumpNativeAccountReport();original=bodies.back();server="Different-account-server";elapsed=1000;PumpNativeAccountReport();check(bodies.back()!=original,"pending report cannot cross account switch");
 reset();httpCode=500;PumpNativeAccountReport();check(nativeAccountDirty&&!nativeAccountEnvelope.empty(),"transport failure holds report");httpCode=200;ackMode=1;elapsed=1000;PumpNativeAccountReport();check(nativeAccountEnvelope.empty()&&!nativeAccountDirty,"exact replay ACK retires same report");
 reset();QueueNativeAccountReport();string valid=ack();check(NativeAccountAcknowledged(valid),"correlated accepted ACK");check(NativeAccountAcknowledged(ack(true)),"exact duplicate ACK");
 std::vector<string> invalid={"{}",valid+"junk",valid.substr(0,valid.size()-1),"[]","{\"ok\":true,\"ok\":true}","{\"ok\":tru}","{\"ok\":true,}","{\"ok\":true,\"x\":01}"};
 for(string bad:invalid)check(!NativeAccountAcknowledged(bad),"malformed acknowledgement refused");
 for(auto edit:std::vector<std::pair<string,string>>{{"\"received\":1","\"received\":2"},{"\"accepted\":1","\"accepted\":0"},{"\"sequence\":0","\"sequence\":1"},{"ACCOUNT_NATIVE_V1","OTHER"},{"ACCOUNT_SNAPSHOT","TICK"},{nativeAccountIdempotency,"other-idempotency"},{"\"accepted\":true","\"accepted\":false"},{"\"outcome\":\"ACCEPTED\"","\"outcome\":\"REJECTED\""}}){string bad=valid;StringReplace(bad,edit.first,edit.second);check(!NativeAccountAcknowledged(bad),"uncorrelated/rejected ACK refused");}
 string conflict=ack(true);StringReplace(conflict,"\"exactReplay\":true","\"exactReplay\":false");check(!NativeAccountAcknowledged(conflict),"sequence or conflicting duplicate is not exact replay");
 string extraResult=valid;StringReplace(extraResult,"}]}","},{}]}");check(!NativeAccountAcknowledged(extraResult),"multiple results refused");
 string stringBool=valid;StringReplace(stringBool,"\"accepted\":true","\"accepted\":\"true\"");check(!NativeAccountAcknowledged(stringBool),"quoted boolean is not proof");
 string escapedKey=valid;StringReplace(escapedKey,"\"ok\"","\"\\u006fk\"");check(!NativeAccountAcknowledged(escapedKey),"escaped receipt keys refused");
 string nestedFake="{\"ok\":true,\"received\":1,\"accepted\":1,\"results\":[{\"nested\":"+valid+"}]}";check(!NativeAccountAcknowledged(nestedFake),"nested success cannot impersonate result");
 check(!NativeAccountAcknowledged(string(8193,' ')),"oversized receipt refused");
 string duplicated=valid;StringReplace(duplicated,"\"ok\":true","\"ok\":false,\"ok\":true");check(!NativeAccountAcknowledged(duplicated),"duplicate JSON key refused");
 reset();ackMode=2;PumpNativeAccountReport();original=bodies.back();nativeAccountDirty=false;elapsed=1000;PumpNativeAccountReport();check(bodies.back()==original&&requests==2,"unACKed report cannot be suppressed by unchanged fingerprint");
 reset();elapsed=(1ULL<<32)-500;PumpNativeAccountReport();elapsed+=999;PumpNativeAccountReport();check(requests==1,"native clock does not fire early across32bit boundary");amounts[2]=100;elapsed+=1;PumpNativeAccountReport();check(requests==2,"native clock due after32bit boundary");
 reset();BridgeToken="";PumpNativeAccountReport();check(requests==0&&!nativeAccountAttempted,"missing token does not consume deadline");BridgeToken="fake-test-only";PumpNativeAccountReport();check(requests==1,"restored configuration sends due capture");
 reset();login=12345678;server="Fixture server";currency="KWD";digits=3;check(QueueNativeAccountReport(),"cross-language fixture queued");std::cout<<"{\"crossLanguage\":true,\"envelope\":"<<nativeAccountEnvelope<<"}\n";
 std::cerr<<checks-failures<<'/'<<checks<<" native-account offline checks pass\n";return failures?1:0;
}
