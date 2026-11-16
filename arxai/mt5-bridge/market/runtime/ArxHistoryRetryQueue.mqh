#ifndef ARX_HISTORY_RETRY_QUEUE_MQH
#define ARX_HISTORY_RETRY_QUEUE_MQH
// Pure bounded scheduling, with no terminal, file, network or trading access.
// Every other selection remains a regular slot, even when all retries fail.
class ArxHistoryRetryQueue {
   int slots[16],attempts[16],cursor;
   long ends[16];
   ulong due[16];
   ulong ackExpires[16];
   bool awaitingAck[16];
   bool retryTurn;
public:
   void Reset() {
      cursor=0;retryTurn=true;
      for(int i=0;i<16;i++) {slots[i]=-1;attempts[i]=0;ends[i]=0;due[i]=0;ackExpires[i]=0;awaitingAck[i]=false;}
   }
   void Forget(int slot) {
      for(int i=0;i<16;i++)if(slots[i]==slot)slots[i]=-1;
   }
   // A successful file write is not a server acknowledgement. Poll only its
   // cursor file while transport is pending; never restamp or resend the page.
   // The same fixed-capacity queue and alternate regular turn bound this work.
   void AwaitAcknowledgement(int slot,long end,ulong now) {
      int found=-1;
      for(int i=0;i<16;i++) {
         if(slots[i]==slot) {found=i;break;}
         if(slots[i]<0 && found<0)found=i;
      }
      if(found<0)return;
      slots[found]=slot;ends[found]=end;attempts[found]=0;
      awaitingAck[found]=true;ackExpires[found]=now+30000;due[found]=now+1000;
   }
   void PollAcknowledgement(int slot,ulong now) {
      for(int i=0;i<16;i++)if(slots[i]==slot && awaitingAck[i]) {
         if(now>=ackExpires[i])slots[i]=-1;else due[i]=now+1000;
         return;
      }
   }
   void Retry(int slot,long end,ulong now) {
      int empty=-1;
      for(int i=0;i<16;i++) {
         if(slots[i]==slot) {
            if(ends[i]!=end || awaitingAck[i]) {ends[i]=end;attempts[i]=0;}
            awaitingAck[i]=false;
            attempts[i]++;
            // Initial attempt plus at most two prompt retries per regular visit.
            if(attempts[i]>=3)slots[i]=-1;else due[i]=now+1000;
            return;
         }
         if(slots[i]<0 && empty<0)empty=i;
      }
      if(empty>=0) {slots[empty]=slot;ends[empty]=end;attempts[empty]=1;due[empty]=now+1000;awaitingAck[empty]=false;}
   }
   int Next(int total,int &regularCursor,ulong now) {
      bool allowRetry=retryTurn;retryTurn=!retryTurn;
      if(allowRetry)for(int offset=0;offset<16;offset++) {
         int i=(cursor+offset)%16;
         if(slots[i]>=0 && awaitingAck[i] && now>=ackExpires[i])slots[i]=-1;
         if(slots[i]>=0 && now>=due[i]) {cursor=(i+1)%16;return slots[i];}
      }
      int slot=regularCursor;regularCursor=(regularCursor+1)%total;return slot;
   }
};
#endif
