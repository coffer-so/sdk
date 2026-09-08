#!/usr/bin/env python3
"""Compile the deployed Rust math as a native, dependency-free reference.
Usage: python3 tests/math/generate-rust-reference.py /path/to/contracts
Only Anchor error plumbing is replaced; arithmetic bodies come from the repo.
"""
import argparse, hashlib, json, pathlib, re, subprocess, tempfile
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("contracts", type=pathlib.Path, help="Contracts repository containing the deployed Rust source")
root = parser.parse_args().contracts.resolve()
sources={
 'log_exp_math':'programs/cubic-pool/src/math/log_exp_math.rs',
 'fixed_point':'programs/cubic-pool/src/math/fixed_point.rs',
 'cubic_math':'programs/cubic-pool/src/math/cubic_math.rs',
 'weighted_math':'programs/cubic-pool/src/math/weighted_math.rs',
 'max_selloff':'programs/cubic-pool/src/math/max_selloff.rs',
 'surge_fee':'programs/cubic-pool/src/math/surge_fee.rs',
 'single_token':'programs/single-token-liquidity/src/math.rs',
}
preamble='''#![allow(dead_code,unused_imports,unused_mut)]
extern crate self as cubic_pool;
#[derive(Debug,Clone,Copy)] enum E {MathOverflow,MathUnderflow,DivisionByZero,AmountOutExceedsBalance,InvalidArrayLength,InvalidTokenCount,PoolNotSeeded,InvalidBptAmount,InvalidWeights,MaxSelloffInvalidConfig,MaxSelloffExceeded,InvalidTokenIndex,InvalidVirtualBalance,AmountTooSmall}
type Result<T> = std::result::Result<T,E>;
macro_rules! require { ($ok:expr,$err:expr) => {if !$ok{return Err($err.into());}}; }
macro_rules! err { ($err:expr) => {Err($err.into())}; }
mod errors {pub(crate) use crate::E as ErrorCode;pub(crate) use crate::E as StldError;}
mod constants {pub const ONE:u128=1_000_000_000_000_000_000;pub const PERCENT_SCALE:u64=10000;pub const MIN_WEIGHT:u64=100;pub const MAX_WEIGHT:u64=9900;pub const WEIGHT_SCALE:u64=10000;pub const SURGE_FEE_SEGMENTS:usize=4;pub fn weight_to_fixed_point(w:u64)->u128{w as u128*ONE/10000}}
mod state {#[derive(Debug,Clone,Copy)] pub struct AssetDynamics {pub virtual_balance:u64,pub actual_balance:u64,pub protocol_fees_owed:u64,pub previous_selloff:u64,pub current_selloff:u64,pub window_start_timestamp:i64,pub selloff_vb_snapshot:u64} pub struct Config {pub max_selloff_pct:u16} pub struct Token {pub config:Config,pub dynamics:AssetDynamics} pub struct CubicPool {pub tokens:Vec<Token>}}
'''
# Sanitizing imports/error types is necessary to compile outside Anchor. No math edits.
def sanitized(text):
 text=text.split('#[cfg(test)]')[0]
 text=re.sub(r'^//!.*$', '', text, flags=re.M)
 text=text.replace('use anchor_lang::prelude::*;', 'use crate::Result;')
 return text
mathmod='mod math {\n'
for name,path in sources.items():
 if name!='single_token':mathmod+='pub mod '+name+' {\n'+sanitized((root/path).read_text())+'\n}\n'
mathmod+='}\nmod single_token {\n'+sanitized((root/sources['single_token']).read_text())+'\n}\n'
# Extract the production four-segment fee block verbatim, adapting only the two
# reads of per-token config to an explicit reference parameter.
swap=(root/'programs/cubic-pool/src/instructions/user/swap.rs').read_text()
block=swap[swap.index('let surge_fee_amount: u64 ='):swap.index('// User receives the curve output')]
block=block.replace('        let cfg = &pool.tokens[token_in_idx].config;','')
wrapper='''struct Curve {variable_fee_threshold_pct:u16,variable_fee_slope_low_pct:u16,variable_fee_slope_mid_pct:u16,variable_fee_slope_high_pct:u16,variable_fee_kink_pct:u8}
use errors::ErrorCode;use math::cubic_math::CubicMath;
fn surge(window:math::max_selloff::MaxSelloffResult,cfg:&Curve,virtual_balance_in:u64,weight_in:u64,virtual_balance_out:u64,weight_out:u64,amount_in_after_fee:u64,actual_balance_out:u64)->Result<u64>{
let decimals_in=9;let decimals_out=9;let max_selloff_result=Some(window);
let amount_out=CubicMath::calc_out_given_in(virtual_balance_in,weight_in,virtual_balance_out,weight_out,amount_in_after_fee,actual_balance_out,9,9)?;
'''+block+'\nOk(surge_fee_amount)\n}\n'
main=r'''
fn value(v:Result<u128>)->String{match v{Ok(x)=>format!("\"{}\"",x),Err(e)=>format!("\"error:{:?}\"",e)}}
fn main(){
use math::log_exp_math::LogExpMath as L;
for x in [1u128,2,1000,999_999_999_999_999_999,1_000_000_000_000_000_000,1_990_000_000_000_000_000,2_000_000_000_000_000_000,2_718_281_828_459_045_235,10_000_000_000_000_000_000,u128::MAX] {
let v=match L::ln(x){Ok(x)=>format!("\"{}\"",x),Err(e)=>format!("\"error:{:?}\"",e)};
println!("{{\"kind\":\"ln\",\"x\":\"{}\",\"expected\":{}}}",x,v);
}
for x in [-42i128,-41,-40,-2,-1,0,1,2,40,46,47] {let x=x*1_000_000_000_000_000_000;println!("{{\"kind\":\"exp\",\"x\":\"{}\",\"expected\":{}}}",x,value(L::exp(x)));}
for base in [1u128,10,999_999_999_999_999_999,501_000_000_000_000_000,1_990_000_000_000_000_000,1_000_000_000_000_000_000,10_000_000_000_000_000_000] {for exp in [0u128,10_101_010_101_010_101,500_000_000_000_000_000,1_000_000_000_000_000_000,4_000_000_000_000_000_000,99_000_000_000_000_000_000]{println!("{{\"kind\":\"pow\",\"base\":\"{}\",\"exponent\":\"{}\",\"expected\":{}}}",base,exp,value(L::pow(base,exp)));}}
let amounts=[1u64,3,1000,100_000_000,990_000_000,1_000_000_000,100_000_000_000,u64::MAX];
for amount in amounts {for wi in [100u64,5000,8000,9500,9900]{let wo=10000-wi;let v=CubicMath::calc_out_given_in(1_000_000_000,wi,1_000_000_000,wo,amount,1_000_000_000,9,9).map(|v|v as u128);println!("{{\"kind\":\"swap\",\"amount\":\"{}\",\"weight\":{},\"expected\":{}}}",amount,wi,value(v));}}
for amounts in [[1_000_000u64,1_000_000],[1_000_000,500_000_000],[400_000,800_000],[68_056_473_384_187_693,68_056_473_384_187_693],[u64::MAX,u64::MAX-1]] {for amount in [1u64,1000,1_000_000,u64::MAX]{let v=single_token::compute_allocations(&amounts,&[1_000_000,1_000_000],&[5000,5000],amount,0).unwrap();println!("{{\"kind\":\"allocation\",\"actual\":[\"{}\",\"{}\"],\"amount\":\"{}\",\"expected\":[\"{}\",\"{}\"]}}",amounts[0],amounts[1],amount,v[0],v[1]);}}
for (before,after,cap) in [(0u64,10000u64,10000u64),(8000,10000,10000),(9999,10000,10000),(5000,5000,10000),(1,2,3),(12345678,556677889,1000000000)] {for (threshold,low,mid,high,kink) in [(0u16,0u16,0u16,3000u16,0u8),(8000,10,100,3000,95),(5000,100,700,8000,80),(10000,0,0,10000,0),(0,100,1000,3000,50)]{let v=math::surge_fee::calc_surge_fee_pct(before,after,cap,threshold,low,mid,high,kink).unwrap();println!("{{\"kind\":\"surgePct\",\"before\":\"{}\",\"after\":\"{}\",\"cap\":\"{}\",\"threshold\":{},\"low\":{},\"mid\":{},\"high\":{},\"kink\":{},\"expected\":\"{}\"}}",before,after,cap,threshold,low,mid,high,kink,v);}}
for wi in [100u64,5000,8000,9500,9900] {for before in [0u64,800_000_000] {let amount=1_000_000_000-before;let window=math::max_selloff::MaxSelloffResult{effective_selloff_before:before,effective_selloff:1_000_000_000,max_selloff_cap:1_000_000_000,vb_snapshot:1_000_000_000,previous_selloff:0,current_selloff:1_000_000_000,window_start_timestamp:0};let cfg=Curve{variable_fee_threshold_pct:8000,variable_fee_slope_low_pct:10,variable_fee_slope_mid_pct:1000,variable_fee_slope_high_pct:8000,variable_fee_kink_pct:90};let v=surge(window,&cfg,1_000_000_000,wi,1_000_000_000,10000-wi,amount,1_000_000_000).map(|v|v as u128);println!("{{\"kind\":\"surgeAmount\",\"before\":\"{}\",\"weight\":{},\"expected\":{}}}",before,wi,value(v));}}
for now in [0i64,10,59,60,70,119,120,500] {let mut d=state::AssetDynamics{virtual_balance:10000,actual_balance:10000,protocol_fees_owed:0,previous_selloff:300,current_selloff:500,window_start_timestamp:0,selloff_vb_snapshot:10000};let r=math::max_selloff::check_and_advance(&mut d,10000,60,100,20000,now).unwrap().unwrap();println!("{{\"kind\":\"selloff\",\"now\":\"{}\",\"expected\":[\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\",\"{}\"]}}",now,r.effective_selloff_before,r.effective_selloff,r.max_selloff_cap,r.vb_snapshot,r.previous_selloff,r.current_selloff,r.window_start_timestamp);}
for decimals in [0u8,6,9,18] {let v=math::weighted_math::WeightedMath::calculate_invariant(&[1_000_000_000,2_000_000_000],&[5000,5000],&[decimals,decimals]);println!("{{\"kind\":\"invariant\",\"decimals\":{},\"expected\":{}}}",decimals,value(v));}
let seeded=math::weighted_math::WeightedMath::calculate_invariant(&[3,3],&[5000,5000],&[0,0]).unwrap() as u64;
let mut supply=seeded;let mut acquired=0u64;
for round in 0..3 {
let (bpt,ratio)=CubicMath::calc_bpt_out_given_exact_tokens_in(&[3,3],&[1,1],&[0,0],supply).unwrap();
let credit=math::fixed_point::FixedPoint::mul_down(3,ratio).unwrap() as u64;
assert!(seeded>=1000 && bpt>0 && credit<=1);
println!("{{\"kind\":\"joinRounding\",\"round\":{},\"supply\":\"{}\",\"expected\":[\"{}\",\"{}\",\"{}\"]}}",round,supply,ratio,bpt,credit);
supply+=bpt;acquired+=bpt;
}
let withdraw=CubicMath::calc_tokens_out_given_bpt_in(&[3,3],acquired,supply,&[0,0]).unwrap();
println!("{{\"kind\":\"joinRoundingExit\",\"supply\":\"{}\",\"acquired\":\"{}\",\"expected\":[\"{}\",\"{}\"]}}",supply,acquired,withdraw[0],withdraw[1]);

}
'''
with tempfile.TemporaryDirectory(prefix='coffer-rust-math-') as tmp:
 tmp=pathlib.Path(tmp);(tmp/'reference.rs').write_text(preamble+mathmod+wrapper+main)
 subprocess.run(['rustc','--edition=2021','-O',str(tmp/'reference.rs'),'-o',str(tmp/'reference')],check=True)
 rows=[json.loads(line) for line in subprocess.check_output([str(tmp/'reference')],text=True).splitlines()]
meta={'contractCommit':subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),'sourceHashes':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in [*sources.values(),'programs/cubic-pool/src/instructions/user/swap.rs']},'vectors':rows}
out=pathlib.Path(__file__).parent/'fixtures/deployed-v5-math.json';out.write_text(json.dumps(meta,indent=2)+'\n');print(f'Wrote {len(rows)} native Rust reference vectors to {out}')
