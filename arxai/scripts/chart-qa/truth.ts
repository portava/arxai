// Offline fixture: no scanner truth request. Mirrors useScannerTruth's return.
export const useScannerTruth = (..._args: unknown[]) => ({truth:null,feedStatus:null,sourceIdentity:null,lastClosedCandleAt:null,isLoading:false,isError:false,refetch:()=>{}});
