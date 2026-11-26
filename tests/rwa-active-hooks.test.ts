import fs from 'fs';import path from 'path';
import {Keypair,PublicKey,AccountInfo} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {resolveTransferExtraAccounts} from '../src';
const root=path.resolve(__dirname,'fixtures/rwa');const hooks:any[]=JSON.parse(fs.readFileSync(path.join(root,'ACTIVE-HOOKS.json'),'utf8'));
const profiles=JSON.parse(fs.readFileSync(path.join(root,'MINT-PROFILES.json'),'utf8')).records;const raws=JSON.parse(fs.readFileSync(path.join(root,'RPC-final-selection-base64.json'),'utf8')).result.value;
const key=(i:number)=>Keypair.fromSeed(Buffer.alloc(32,i)).publicKey;
const account=(data:Buffer,owner=TOKEN_2022_PROGRAM_ID,executable=false):AccountInfo<Buffer>=>({data,owner,executable,lamports:1});
for(const h of hooks)for(const fresh of [false,true])test(h.symbol+' exact public registry '+(fresh?'future ATA':'existing account')+' resolution (synthetic local compliance data)',async()=>{
 const mint=new PublicKey(h.mint),program=new PublicKey(h.hook_program),registry=new PublicKey(h.extra_account_meta_list);
 const owner=key(31),sourceOwner=key(30),source=key(32),destination=getAssociatedTokenAddressSync(mint,owner,true,TOKEN_2022_PROGRAM_ID);
 const sourceData=Buffer.alloc(165);mint.toBuffer().copy(sourceData);sourceOwner.toBuffer().copy(sourceData,32);sourceData[108]=1;
 const destData=Buffer.from(sourceData);owner.toBuffer().copy(destData,32);
 const infos=new Map<string,AccountInfo<Buffer>>([[program.toBase58(),account(Buffer.alloc(0),program,true)],[registry.toBase58(),account(Buffer.from(h.raw_hex,'hex'),program)],[source.toBase58(),account(sourceData)]]);
 if(!fresh)infos.set(destination.toBase58(),account(destData));
 const expected:PublicKey[]=[];const writable:boolean[]=[];const configMint=key(35),identityA=key(36),identityB=key(37);
 const literal=(i:number)=>new PublicKey(Buffer.from(h.entries[i].address_config_hex,'hex'));
 const pda=(seeds:Buffer[],id=program)=>PublicKey.findProgramAddressSync(seeds,id)[0];
 if(h.symbol==='BENJI')expected.push(literal(0),literal(1),literal(2),pda([literal(2).toBuffer(),sourceOwner.toBuffer()],literal(0)),pda([literal(2).toBuffer(),owner.toBuffer()],literal(0)));
 if(h.symbol==='WTGXX'){
  const config=pda([Buffer.from('compliance_config'),mint.toBuffer()]),bytes=Buffer.alloc(72);configMint.toBuffer().copy(bytes,40);infos.set(config.toBase58(),account(bytes,program));
  expected.push(config,literal(1),literal(2),pda([sourceOwner.toBuffer(),literal(2).toBuffer(),configMint.toBuffer()],literal(1)),pda([owner.toBuffer(),literal(2).toBuffer(),configMint.toBuffer()],literal(1)));
 }
 if(h.symbol==='BUIDL'){
  const external=literal(1),src=pda([sourceOwner.toBuffer(),mint.toBuffer()],external),dst=pda([owner.toBuffer(),mint.toBuffer()],external);
  for(const [address,identity]of [[src,identityA],[dst,identityB]]){const bytes=Buffer.alloc(40);identity.toBuffer().copy(bytes,8);infos.set(address.toBase58(),account(bytes,external));}
  expected.push(pda([mint.toBuffer()]),external,pda([mint.toBuffer()],external),src,dst,identityA,identityB,pda([mint.toBuffer(),identityA.toBuffer()]),pda([mint.toBuffer(),identityB.toBuffer()]));
 }
 const index=profiles.findIndex((p:any)=>p.symbol===h.symbol),reader={getAccountInfo:async(k:PublicKey)=>infos.get(k.toBase58())??null,getMultipleAccountsInfo:async(ks:PublicKey[])=>ks.map(k=>infos.get(k.toBase58())??null)};
 const result=await resolveTransferExtraAccounts(reader,[{mint,tokenProgram:TOKEN_2022_PROGRAM_ID,source,destination,authority:sourceOwner,amount:123n,destinationCreatedInTx:fresh,destinationOwner:fresh?owner:undefined}],[{address:mint,owner:TOKEN_2022_PROGRAM_ID,data:Buffer.from(raws[index].data[0],'base64')}],[]);
 expect(result.map(x=>x.pubkey.toBase58())).toEqual([...expected,program,registry].map(x=>x.toBase58()));
 expect(result.slice(0,expected.length).map(x=>x.isWritable)).toEqual(h.entries.map((x:any)=>x.is_writable));expect(result.some(x=>x.isSigner)).toBe(false);
});
