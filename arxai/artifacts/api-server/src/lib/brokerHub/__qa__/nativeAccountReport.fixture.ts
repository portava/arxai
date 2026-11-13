import { nativeAccountBinding, type NativeAccountConnection, type NativeAccountReceipt } from "../nativeAccountReport.js";
export const NOW = Date.UTC(2026, 10, 13, 12);
export const connection: NativeAccountConnection = { id: 401, userId: 402, accountNumber: "00012345", serverName: "Fixture-Demo" };
export const payload = () => ({ reportVersion: 1, source: "NATIVE_ACCOUNT_INFO", accountBinding: nativeAccountBinding(connection.accountNumber, connection.serverName)!,
  producerInstanceId: "a".repeat(32), observedAtEpochMs: NOW - 1000, clockBasis: "TERMINAL_UTC_UNVERIFIED", captureDurationMs: 2,
  terminalConnected: true, currency: "USD", currencyDigits: 2, balance: "9007199254740993.12", equity: "9007199254741000.34",
  profit: "-8.76", credit: "10.00", margin: "2.00", freeMargin: "9007199254740998.34" });
export const receipt = (over: Partial<NativeAccountReceipt> = {}): NativeAccountReceipt => ({ userId: connection.userId!, bridgeConnectionId: connection.id,
  protocolVersion: 2, messageType: "ACCOUNT_SNAPSHOT", streamKey: "ACCOUNT_NATIVE_V1", sequence: 8, idempotencyKey: "native-account-fixture-8", eaVersion: "test", eaCreatedAtEpochMs: NOW - 500,
  accepted: true, sequenceVerdict: "IN_ORDER", duplicateDropped: false, serverReceivedAtEpochMs: NOW - 100, payload: payload(), ...over });
