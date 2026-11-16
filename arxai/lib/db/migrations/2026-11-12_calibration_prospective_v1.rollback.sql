-- Disable capture without deleting registrations/evidence. Evaluator refuses
-- while capture is absent. A later re-enable must use NEW cohorts: the receipt
-- log cannot establish coverage across a disabled period.
DROP TRIGGER IF EXISTS calibration_prospective_capture ON eleanor_signal_outcomes;
