// Fake terminal only: no HTTP, account, position or order APIs are available.
#include <algorithm>
#include <cstdint>
#include <iostream>
#include <string>
using datetime = long long;
using string = std::string;
using ulong = unsigned long;
static_assert(sizeof(ulong) == 8, "MQL ulong is 64-bit");
datetime quoteTime = 1'800'000'000;
ulong elapsedMs = 0;
datetime TimeCurrent() { return quoteTime; }
ulong GetTickCount64() { return elapsedMs; }
int MathMax(int a, int b) { return std::max(a, b); }
int StringLen(const string &s) { return static_cast<int>(s.size()); }
string BridgeBaseUrl = "offline-test", BridgeToken = "fake-token";
int HeartbeatIntervalSeconds = 15, AccountSnapshotIntervalSeconds = 10;
int SnapshotIntervalSeconds = 10, BookSnapshotIntervalSeconds = 10;
int ConfigPollIntervalSeconds = 10, CommandPollIntervalSeconds = 5;
int PollIntervalSeconds = 5, CandlePushIntervalSeconds = 30, LiveStreamIntervalSeconds = 2;
bool StreamCandleHistory = false, StreamLiveBrokerData = false;
datetime lastHeartbeatAt = 0, lastAccountAt = 0, lastBookAt = 0;
datetime lastConfigPollAt = 0, lastCommandPollAt = 0, lastSnapshotAt = 0;
datetime lastPollAt = 0, lastCandlePushAt = 0, lastLiveStreamAt = 0;
int heartbeats = 0, accounts = 0, positions = 0, orders = 0;
int configs = 0, commands = 0, snapshots = 0, candles = 0, streams = 0;
void SendHeartbeat() { ++heartbeats; }
void PushAccountSnapshot() { ++accounts; }
void PushPositionsSnapshot() { ++positions; }
void PushOrdersSnapshot() { ++orders; }
void PollRemoteConfig() { ++configs; }
void PollCommands() { ++commands; }
void PushSnapshots() { ++snapshots; }
void PollAndExecute() { ++commands; }
void PushCandleHistory() { ++candles; }
void PushLiveBrokerStream() { ++streams; }
void PumpNativeAccountReport() {} // separately exercised by native_account_report_test.cpp
#include "account_timer_wire.inc"

int failures = 0, checks = 0;
void check(bool value, const char *message) {
  ++checks;
  if (!value) { ++failures; std::cerr << "FAIL " << message << '\n'; }
}
int count() { return UNIVERSAL ? heartbeats : accounts; }
int &interval() { return UNIVERSAL ? HeartbeatIntervalSeconds : AccountSnapshotIntervalSeconds; }
int main() {
  interval() = TELEMETRY_INTERVAL;
  // Initial attempt even with quote time zero and monotonic uptime zero.
  quoteTime = 0;
  OnTimer(); check(count() == 1, "initial telemetry at zero broker clock");
  const int cadence = interval();
  elapsedMs = cadence * 1000 - 1;
  OnTimer(); check(count() == 1, "no report before monotonic deadline");
  elapsedMs += 1;
  OnTimer(); check(count() == 2, "quiet broker clock cannot freeze telemetry");
  OnTimer(); check(count() == 2, "same timer event does not repeat report");

  // A broker clock jump affects the untouched schedulers, never the money clock.
  quoteTime = 1'900'000'000;
  OnTimer(); check(count() == 2, "broker forward jump cannot send early telemetry");
  int commandsBefore = commands;
  elapsedMs += cadence * 1000;
  OnTimer(); check(count() == 3, "next report with broker time frozen");
  check(commands == commandsBefore, "telemetry fix does not accelerate command polling");
  quoteTime -= 86'400;
  elapsedMs += cadence * 1000;
  OnTimer(); check(count() == 4, "broker backward jump cannot suspend telemetry");
  check(commands == commandsBefore, "backward clock leaves command scheduler unchanged");
  check(candles == 0 && streams == 0, "disabled market telemetry stays disabled");

  // Long suspension makes one attempt, never a catch-up burst.
  elapsedMs += 7ULL * 86'400 * 1000;
  int before = count(); OnTimer();
  check(count() == before + 1, "suspension coalesces missed telemetry intervals");
  OnTimer(); check(count() == before + 1, "no backlog loop");
  elapsedMs = (1ULL << 32) + 1000;
  OnTimer(); before = count();
  elapsedMs += cadence * 1000;
  OnTimer(); check(count() == before + 1, "64-bit uptime works beyond 49 days");

  // Missing configuration never emits, and never consumes the pending deadline.
  BridgeToken = ""; elapsedMs += cadence * 1000; before = count();
  OnTimer(); check(count() == before, "missing token idles");
  BridgeToken = "fake-token"; BridgeBaseUrl = "";
  OnTimer(); check(count() == before, "missing URL idles");
  BridgeBaseUrl = "offline-test";
  OnTimer(); check(count() == before + 1, "configuration restoration preserves due report");

  // Misconfigured intervals retain the existing one-second timer lower bound.
  interval() = 0; before = count();
  elapsedMs += 999; OnTimer(); check(count() == before, "zero interval cannot spin");
  ++elapsedMs; OnTimer(); check(count() == before + 1, "zero interval bounded at one second");
  interval() = -50; before = count();
  elapsedMs += 999; OnTimer(); check(count() == before, "negative interval cannot spin");
  ++elapsedMs; OnTimer(); check(count() == before + 1, "negative interval bounded at one second");
  // A 32-bit clock substituted at the call site would fire early across wrap.
  interval() = cadence;
  elapsedMs = (1ULL << 33) - 500;
  OnTimer(); before = count();
  elapsedMs += 999;
  OnTimer(); check(count() == before, "32-bit rollover cannot force early report");
  elapsedMs += cadence * 1000;
  OnTimer(); check(count() == before + 1, "report remains due after rollover boundary");
  interval() = 2'147'483'647; before = count();
  elapsedMs += 1000; OnTimer(); check(count() == before, "large interval multiplication does not overflow");
  elapsedMs += 2'147'483'647ULL * 1000;
  OnTimer(); check(count() == before + 1, "large interval eventually becomes due");
  std::cout << checks - failures << '/' << checks << " offline timer checks pass\n";
  return failures ? 1 : 0;
}
