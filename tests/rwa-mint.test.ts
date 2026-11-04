import fs from 'fs';
import path from 'path';
import { decodeMintAccount, validateTransferMintSnapshot, effectiveScaledUiMultiplier, rawAmountToScaledUiString, scaledUiAmountToRaw, scaledUiPriceToUnscaledPrice, unscaledPriceToScaledUiPrice } from '../src';
import { PublicKey } from '@solana/web3.js';
const inputs=path.resolve(__dirname,'fixtures/rwa');
const profiles=JSON.parse(fs.readFileSync(path.join(inputs,'MINT-PROFILES.json'),'utf8')).records;
const raw=JSON.parse(fs.readFileSync(path.join(inputs,'RPC-final-selection-base64.json'),'utf8')).result.value;
for(let i=0;i<profiles.length;i++) test('real finalized profile '+profiles[i].symbol+' bodies decode',()=>{
 const p=profiles[i];
 const parsed=validateTransferMintSnapshot(new PublicKey(p.mint),new PublicKey(p.owner),Buffer.from(raw[i].data[0],'base64'));
 expect(parsed.supply.toString()).toBe(p.supply);
 const scaled=p.extensions.find((x:any)=>x.extension==='scaledUiAmountConfig');
 expect(!!parsed.scaledUiAmountConfig).toBe(!!scaled);
 if(scaled){expect(parsed.scaledUiAmountConfig!.multiplier).toBe(Number(scaled.state.multiplier));expect(parsed.scaledUiAmountConfig!.newMultiplierEffectiveTimestamp).toBe(BigInt(scaled.state.newMultiplierEffectiveTimestamp));}
 const state=p.extensions.find((x:any)=>x.extension==='defaultAccountState');
 expect(parsed.defaultAccountState?.state??null).toBe(!state?null:state.state.accountState==='frozen'?2:1);
 const delegate=p.extensions.find((x:any)=>x.extension==='permanentDelegate');
 expect(parsed.permanentDelegate?.delegate.toBase58()??null).toBe(delegate?.state.delegate??null);
 const confidential=p.extensions.find((x:any)=>x.extension==='confidentialTransferMint');
 expect(!!parsed.confidentialTransferMint).toBe(!!confidential);
});
const cfg={authority:PublicKey.default,multiplier:2,newMultiplier:4,newMultiplierEffectiveTimestamp:100n};
test('effective/pending activation uses exact cluster time and signed timestamp',()=>{
 expect(effectiveScaledUiMultiplier(cfg,99n)).toBe(2);expect(effectiveScaledUiMultiplier(cfg,100n)).toBe(4);
 const base=Buffer.alloc(226);base[45]=1;base[165]=1;base.writeUInt16LE(25,166);base.writeUInt16LE(56,168);base.writeDoubleLE(2,202);base.writeBigInt64LE(-1n,210);base.writeDoubleLE(4,218);
 expect(decodeMintAccount(base).scaledUiAmountConfig!.newMultiplierEffectiveTimestamp).toBe(-1n);
});
test('u64 balance arithmetic stays exact above JS safe integers',()=>{
 expect(rawAmountToScaledUiString(18446744073709551615n,9,cfg,99n)).toBe('36893488147.41910323');
 expect(scaledUiAmountToRaw('36893488147.41910323',9,cfg,99n)).toBe(18446744073709551615n);
 expect(rawAmountToScaledUiString(9007199254740993n,0,cfg,100n)).toBe('36028797018963972');
});
test('display, raw and price conversion applies multiplier once',()=>{
 expect(rawAmountToScaledUiString(1000000n,6,cfg,99n)).toBe('2');
 expect(scaledUiAmountToRaw('2.000001',6,cfg,99n)).toBe(1000000n);
 expect(scaledUiPriceToUnscaledPrice('25',cfg,99n)).toBe('50');
 expect(unscaledPriceToScaledUiPrice('50',cfg,99n)).toBe('25');
});
test.each([0,-1,Infinity,NaN,Number.MIN_VALUE])('invalid multiplier %p fails closed',value=>expect(()=>effectiveScaledUiMultiplier({...cfg,multiplier:value},0n)).toThrow());
test('InterestBearing uses separate typed body; both extensions are invalid',()=>{
 const data=Buffer.alloc(222);data[45]=1;data[165]=1;data.writeUInt16LE(10,166);data.writeUInt16LE(52,168);data.writeBigInt64LE(-7n,202);data.writeInt16LE(-4,210);data.writeBigInt64LE(9007199254740993n,212);data.writeInt16LE(25,220);
 const decoded=decodeMintAccount(data);expect(decoded.interestBearingConfig!.initializationTimestamp).toBe(-7n);expect(decoded.interestBearingConfig!.lastUpdateTimestamp).toBe(9007199254740993n);expect(decoded.scaledUiAmountConfig).toBeNull();
 const scaled=Buffer.alloc(60);scaled.writeUInt16LE(25);scaled.writeUInt16LE(56,2);scaled.writeDoubleLE(1,36);scaled.writeDoubleLE(1,52);
 expect(()=>decodeMintAccount(Buffer.concat([data,scaled]))).toThrow(/Combination/);
});
