import { AccountInfo, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getExtraAccountMetaAddress } from '@solana/spl-token';
import { resolveTransferExtraAccounts } from '../src';
const key=(i:number)=>Keypair.fromSeed(Buffer.alloc(32,i)).publicKey;
const mint=key(1), owner=key(2), source=key(3), hook=key(4), authority=key(5);
const destination=getAssociatedTokenAddressSync(mint,owner,true,TOKEN_2022_PROGRAM_ID);
const registry=getExtraAccountMetaAddress(mint,hook);
const info=(data:Buffer,program=TOKEN_2022_PROGRAM_ID,executable=false):AccountInfo<Buffer>=>({data,owner:program,executable,lamports:1});
function fixture(seed=Buffer.from([4,2,32,32])) {
 const data=Buffer.alloc(234);data[44]=6;data[45]=1;data[165]=1;data.writeUInt16LE(14,166);data.writeUInt16LE(64,168);hook.toBuffer().copy(data,202);
 const list=Buffer.alloc(51);Buffer.from([105,37,101,197,75,251,102,26]).copy(list);list.writeUInt32LE(39,8);list.writeUInt32LE(1,12);list[16]=1;seed.copy(list,17);
 const reader={getAccountInfo:async(k:PublicKey)=>k.equals(hook)?info(Buffer.alloc(0),hook,true):k.equals(registry)?info(list,hook):null,getMultipleAccountsInfo:async(ks:PublicKey[])=>ks.map(()=>null)};
 const leg={mint,tokenProgram:TOKEN_2022_PROGRAM_ID,source,destination,authority,amount:1n,destinationCreatedInTx:true,destinationOwner:owner};
 return {reader,leg,snapshot:{address:mint,owner:TOKEN_2022_PROGRAM_ID,data}};
}
test('new canonical ATA resolves owner account-data seeds before it exists',async()=>{
 const f=fixture();const result=await resolveTransferExtraAccounts(f.reader,[f.leg],[f.snapshot],[]);
 expect(result[0].pubkey.equals(PublicKey.findProgramAddressSync([owner.toBuffer()],hook)[0])).toBe(true);
});
test('future ATA cannot fabricate amount-dependent state',async()=>{
 const f=fixture(Buffer.from([4,2,64,8]));await expect(resolveTransferExtraAccounts(f.reader,[f.leg],[f.snapshot],[])).rejects.toThrow(/future|prepar/i);
});
test('future owner declaration must derive exact canonical ATA',async()=>{
 const f=fixture();f.leg.destination=key(8);await expect(resolveTransferExtraAccounts(f.reader,[f.leg],[f.snapshot],[])).rejects.toThrow(/canonical|ATA/);
});
test('zero transfers do not demand mint snapshot, destination or hook registry',async()=>{
 const f=fixture();f.leg.amount=0n;expect(await resolveTransferExtraAccounts(f.reader,[f.leg],[],[])).toEqual([]);
});

test('disarmed hook needs no metas; a rearmed mint requires a fresh resolution',async()=>{
 const f=fixture();f.snapshot.data.fill(0,202,234);
 expect(await resolveTransferExtraAccounts(f.reader,[f.leg],[f.snapshot],[])).toEqual([]);
 hook.toBuffer().copy(f.snapshot.data,202);
 const metas=await resolveTransferExtraAccounts(f.reader,[f.leg],[f.snapshot],[]);
 expect(metas.some(m=>m.pubkey.equals(hook))).toBe(true);
 expect(metas[0].pubkey.equals(PublicKey.findProgramAddressSync([owner.toBuffer()],hook)[0])).toBe(true);
});
