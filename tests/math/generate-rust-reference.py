#!/usr/bin/env python3
"""Compile the contracts `v6` Rust math as a native, dependency-free reference.
Usage: python3 tests/math/generate-rust-reference.py /path/to/contracts   (checkout of `v6`)
Only Anchor error plumbing is replaced; arithmetic bodies come from the repo.
The one visibility edit is `rebase_snapshot` (private in the program) so the
SDK's exported `rebaseSnapshot` can be pinned to it directly.
"""
import argparse, hashlib, json, pathlib, re, subprocess, tempfile
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("contracts", type=pathlib.Path, help="Contracts repository checked out at the v6 revision")
root = parser.parse_args().contracts.resolve()
sources={
 'log_exp_math':'programs/coffer-pool/src/math/log_exp_math.rs',
 'fixed_point':'programs/coffer-pool/src/math/fixed_point.rs',
 'pool_math':'programs/coffer-pool/src/math/pool_math.rs',
 'weighted_math':'programs/coffer-pool/src/math/weighted_math.rs',
 'max_selloff':'programs/coffer-pool/src/math/max_selloff.rs',
 'surge_fee':'programs/coffer-pool/src/math/surge_fee.rs',
 'single_token':'programs/single-token-liquidity/src/math.rs',
}
SWAP='programs/coffer-pool/src/instructions/user/swap.rs'
preamble='''#![allow(dead_code,unused_imports,unused_mut,unused_variables)]
extern crate self as coffer_pool;
#[derive(Debug,Clone,Copy)] enum E {MathOverflow,MathUnderflow,DivisionByZero,AmountOutExceedsBalance,InvalidArrayLength,InvalidTokenCount,PoolNotSeeded,InvalidLpAmount,InvalidWeights,MaxSelloffInvalidConfig,MaxSelloffExceeded,InvalidTokenIndex,InvalidVirtualBalance,AmountTooSmall,TokenLivenessMismatch,InvalidVirtualBalances,InvalidAmounts,TransferFeeCalculationMismatch,AmountFullyConsumedByTransferFee,TokenInactive,DepositTooSmall,InvalidSurgeFeeConfig,ZeroFeeAmount,InsufficientLiquidity,SlippageExceeded}
type Result<T> = std::result::Result<T,E>;
macro_rules! require { ($ok:expr,$err:expr) => {if !$ok{return Err($err.into());}}; }
macro_rules! err { ($err:expr) => {Err($err.into())}; }
mod errors {pub(crate) use crate::E as ErrorCode;pub(crate) use crate::E as StldError;}
mod constants {pub const ONE:u128=1_000_000_000_000_000_000;pub const PERCENT_SCALE:u64=10000;pub const MIN_WEIGHT:u64=100;pub const MAX_WEIGHT:u64=9900;pub const WEIGHT_SCALE:u64=10000;pub const SURGE_FEE_SEGMENTS:u8=4;pub const MIN_LP_SUPPLY:u64=1_000;pub const SWAP_FEE_PRECISION:u64=1_000_000;pub const PROTOCOL_FEE_PRECISION:u64=10_000;pub fn weight_to_fixed_point(w:u64)->u128{w as u128*ONE/10000}}
mod state {#[derive(Debug,Clone,Copy,Default)] pub struct AssetDynamics {pub virtual_balance:u64,pub actual_balance:u64,pub protocol_fees_owed:u64,pub previous_selloff:u64,pub current_selloff:u64,pub window_start_timestamp:i64,pub selloff_vb_snapshot:u64} pub struct Config {pub max_selloff_pct:u16} pub struct Token {pub config:Config,pub dynamics:AssetDynamics} pub struct CofferPool {pub tokens:Vec<Token>}}
'''
# Sanitizing imports/error types is necessary to compile outside Anchor. No math edits.
def sanitized(text):
 text=text.split('#[cfg(test)]')[0]
 text=re.sub(r'^//!.*$', '', text, flags=re.M)
 text=text.replace('use anchor_lang::prelude::*;', 'use crate::Result;')
 text=text.replace('\nfn rebase_snapshot(', '\npub fn rebase_snapshot(')
 return text
mathmod='mod math {\n'
for name,path in sources.items():
 if name!='single_token':mathmod+='pub mod '+name+' {\n'+sanitized((root/path).read_text())+'\n}\n'
mathmod+='}\nmod single_token {\n'+sanitized((root/sources['single_token']).read_text())+'\n}\n'
swap=(root/SWAP).read_text()
# The two fee helpers verbatim (ceil rounding is the audited behaviour).
fees=swap[swap.index('pub fn calculate_swap_fee'):swap.index('#[cfg(test)]\nmod protocol_fee_tests')]
# The production surge charge verbatim, adapting only the per-token config
# read to an explicit reference parameter.
block=swap[swap.index('let surge_fee_amount: u64 ='):swap.index('// User receives the curve output')]
block=block.replace('        let cfg = &pool.tokens[token_in_idx].config;','')
wrapper='''struct Curve {variable_fee_threshold_pct:u16,variable_fee_slope_low_pct:u16,variable_fee_slope_mid_pct:u16,variable_fee_slope_high_pct:u16,variable_fee_kink_pct:u8}
use errors::ErrorCode;use math::pool_math::PoolMath;use state::AssetDynamics;
'''+fees+'''
fn surge(window:math::max_selloff::MaxSelloffResult,cfg:&Curve,virtual_balance_in:u64,weight_in:u64,virtual_balance_out:u64,weight_out:u64,amount_in_after_fee:u64,actual_balance_out:u64)->Result<u64>{
let decimals_in=9;let decimals_out=9;let max_selloff_result=Some(window);
let amount_out=PoolMath::calc_out_given_in(virtual_balance_in,weight_in,virtual_balance_out,weight_out,amount_in_after_fee,actual_balance_out,9,9)?;
'''+block+'\nOk(surge_fee_amount)\n}\n'
main=r'''
fn value<T:std::fmt::Display>(v:Result<T>)->String{match v{Ok(x)=>format!("\"{}\"",x),Err(e)=>format!("\"error:{:?}\"",e)}}
fn list(v:Result<Vec<u64>>)->String{match v{Ok(x)=>format!("[{}]",x.iter().map(|x|format!("\"{}\"",x)).collect::<Vec<_>>().join(",")),Err(e)=>format!("\"error:{:?}\"",e)}}
fn dyn_state(snap:u64,prev:u64,cur:u64,ws:i64)->AssetDynamics{AssetDynamics{virtual_balance:0,actual_balance:0,protocol_fees_owed:0,previous_selloff:prev,current_selloff:cur,window_start_timestamp:ws,selloff_vb_snapshot:snap}}
fn main(){
use math::log_exp_math::LogExpMath as L;
const M:u64=u64::MAX;
for x in [1u128,2,1000,999_999_999_999_999_999,1_000_000_000_000_000_000,1_990_000_000_000_000_000,2_000_000_000_000_000_000,2_718_281_828_459_045_235,10_000_000_000_000_000_000,u128::MAX] {
println!("{{\"kind\":\"ln\",\"x\":\"{}\",\"expected\":{}}}",x,value(L::ln(x)));
}
for x in [-42i128,-41,-40,-2,-1,0,1,2,40,46,47] {let x=x*1_000_000_000_000_000_000;println!("{{\"kind\":\"exp\",\"x\":\"{}\",\"expected\":{}}}",x,value(L::exp(x)));}
for base in [1u128,10,999_999_999_999_999_999,501_000_000_000_000_000,1_990_000_000_000_000_000,1_000_000_000_000_000_000,10_000_000_000_000_000_000] {for exp in [0u128,10_101_010_101_010_101,500_000_000_000_000_000,1_000_000_000_000_000_000,4_000_000_000_000_000_000,99_000_000_000_000_000_000]{println!("{{\"kind\":\"pow\",\"base\":\"{}\",\"exponent\":\"{}\",\"expected\":{}}}",base,exp,value(L::pow(base,exp)));}}
let amounts=[1u64,3,1000,100_000_000,990_000_000,1_000_000_000,100_000_000_000,M];
for amount in amounts {for wi in [100u64,5000,8000,9500,9900]{let wo=10000-wi;println!("{{\"kind\":\"swap\",\"amount\":\"{}\",\"weight\":{},\"expected\":{}}}",amount,wi,value(PoolMath::calc_out_given_in(1_000_000_000,wi,1_000_000_000,wo,amount,1_000_000_000,9,9)));}}
// v6: equal positive weights take the exact `base` path (no ln/exp); unequal keep pow.
for (vb_in,vb_out,actual_out) in [(1_000_000_000u64,1_000_000_000u64,1_000_000_000u64),(1,1,1),(3,7,7),(1_000_000,3_000_000_000,3_000_000_000),(M,M,M),(M,1,1),(1_000_000_000,2_000_000_000,500_000_000)] {for amount in [1u64,2,999,1_000_000,1_000_000_000,M] {for w in [100u64,2500,5000,9900,10000]{println!("{{\"kind\":\"swapEqualWeights\",\"vbIn\":\"{}\",\"vbOut\":\"{}\",\"actualOut\":\"{}\",\"amount\":\"{}\",\"weight\":{},\"expected\":{}}}",vb_in,vb_out,actual_out,amount,w,value(PoolMath::calc_out_given_in(vb_in,w,vb_out,w,amount,actual_out,9,9)));}}}
for amounts in [[1_000_000u64,1_000_000],[1_000_000,500_000_000],[400_000,800_000],[68_056_473_384_187_693,68_056_473_384_187_693],[M,M-1]] {for amount in [1u64,1000,1_000_000,M]{println!("{{\"kind\":\"allocation\",\"actual\":[\"{}\",\"{}\"],\"amount\":\"{}\",\"expected\":{}}}",amounts[0],amounts[1],amount,list(single_token::compute_allocations(&amounts,&[1_000_000,1_000_000],&[5000,5000],amount,0)));}}
let curves=[(0u16,0u16,0u16,3000u16,0u8),(8000,10,100,3000,95),(5000,100,700,8000,80),(10000,0,0,10000,0),(0,100,1000,3000,50),(2000,100,500,5000,60),(3000,250,800,4000,70),(5000,20000,30000,65535,70),(2000,700,100,3000,50)];
for (before,after,cap) in [(0u64,10000u64,10000u64),(8000,10000,10000),(9999,10000,10000),(5000,5000,10000),(1,2,3),(12345678,556677889,1000000000),(2001,2001,10000),(6000,6000,10000),(3001,3001,10000),(2500,2500,10000),(7500,7500,10000),(0,1,M),(M-1,M,M),(10000,10000,10000),(0,0,10000)] {for (threshold,low,mid,high,kink) in curves{
println!("{{\"kind\":\"surgeRate\",\"before\":\"{}\",\"after\":\"{}\",\"cap\":\"{}\",\"threshold\":{},\"low\":{},\"mid\":{},\"high\":{},\"kink\":{},\"expected\":{}}}",before,after,cap,threshold,low,mid,high,kink,value(math::surge_fee::calc_surge_fee_rate(before,after,cap,threshold,low,mid,high,kink)));
println!("{{\"kind\":\"surgePct\",\"before\":\"{}\",\"after\":\"{}\",\"cap\":\"{}\",\"threshold\":{},\"low\":{},\"mid\":{},\"high\":{},\"kink\":{},\"expected\":{}}}",before,after,cap,threshold,low,mid,high,kink,value(math::surge_fee::calc_surge_fee_pct(before,after,cap,threshold,low,mid,high,kink)));}}
// Production charge through the swap handler block: window advances by the net input,
// the curve sees the post-fee input (span = after - before = amount_in_net).
let std_curve=(8000u16,10u16,1000u16,8000u16,90u8);
let mut surge_cases:Vec<(u64,u64,u64,(u16,u16,u16,u16,u8),u64,u64,u64,u32)>=Vec::new();
for wi in [100u64,5000,8000,9500,9900] {for before in [0u64,800_000_000] {surge_cases.push((before,1_000_000_000,1_000_000_000,std_curve,wi,1_000_000_000,1_000_000_000,0));}}
surge_cases.extend([
 (700_000_000,900_000_000,1_000_000_000,std_curve,5000,1_000_000_000,1_000_000_000,3000),
 (700_000_000,900_000_000,1_000_000_000,std_curve,8000,1_000_000_000,1_000_000_000,3000),
 (999_999_998,1_000_000_000,1_000_000_000,std_curve,5000,1_000_000_000,1_000_000_000,0),
 (999_999_999,1_000_000_000,1_000_000_000,std_curve,5000,1_000_000_000,1_000_000_000,0),
 (0,1000,1000,(8000,0,0,3000,0),5000,1_000_000,1_000_000,0),
 (0,1001,1001,(8000,0,0,3000,0),5000,1_000_000,1_000_000,0),
 (0,500,1000,(0,100,1000,3000,50),8000,1_000_000,1_000_000,0),
 (800,1000,1000,(8000,10000,10000,10000,0),5000,1_000_000,1_000_000,0),
 (0,1000,1000,(5000,20000,30000,65535,70),5000,1_000_000,1_000_000,1_000_000),
 (0,3,3,(0,100,1000,3000,50),5000,1_000_000,1_000_000,0),
 (0,10,10,(5000,100,700,8000,80),2500,1_000_000,2_000_000,0),
 (0,M,M,(0,0,0,10000,0),5000,M,M,0),
 (900_000_000,1_000_000_000,1_000_000_000,std_curve,5000,1_000_000_000,100_000_000,0),
]);
for (before,after,cap,(threshold,low,mid,high,kink),wi,vb_in,vb_out,fee_rate) in surge_cases {
let net=after-before;let fee=calculate_swap_fee(net,fee_rate).unwrap();let amount=net-fee;
let window=math::max_selloff::MaxSelloffResult{effective_selloff_before:before,effective_selloff:after,max_selloff_cap:cap,vb_snapshot:cap,previous_selloff:0,current_selloff:after,window_start_timestamp:0};
let cfg=Curve{variable_fee_threshold_pct:threshold,variable_fee_slope_low_pct:low,variable_fee_slope_mid_pct:mid,variable_fee_slope_high_pct:high,variable_fee_kink_pct:kink};
println!("{{\"kind\":\"surgeAmount\",\"before\":\"{}\",\"after\":\"{}\",\"cap\":\"{}\",\"threshold\":{},\"low\":{},\"mid\":{},\"high\":{},\"kink\":{},\"weight\":{},\"vbIn\":\"{}\",\"vbOut\":\"{}\",\"amountInAfterFee\":\"{}\",\"expected\":{}}}",before,after,cap,threshold,low,mid,high,kink,wi,vb_in,vb_out,amount,value(surge(window,&cfg,vb_in,wi,vb_out,10000-wi,amount,vb_out)));}
// (snapshot, previous, current, window_start, pct, period, amount_in, vb, now)
let mut selloff_cases:Vec<(u64,u64,u64,i64,u64,u32,u64,u64,i64)>=Vec::new();
for now in [0i64,10,59,60,70,119,120,500] {selloff_cases.push((10000,300,500,0,10000,60,100,20000,now));}
selloff_cases.extend([
 (3,0,1,100,10000,60,0,1,160),(1,1,0,160,10000,60,1,1,280),
 (10,0,7,0,10000,60,0,3,60),(10,0,7,0,10000,60,1,3,60),
 (10000,0,1000,0,1000,60,1,10000,1),(0,0,0,0,10000,60,300,10000,10),
 (10000,0,1000,0,1000,600,400,1_000_000,100),(10000,500,0,0,10000,60,100,10000,70),
 (10000,0,0,100,10000,60,50,10000,80),(10000,M/2,M/2,0,10000,60,100,10000,i64::MAX/4),
 (10000,0,8000,0,5000,60,1,10000,10),(10000,0,0,0,10000,0,10,10000,0),(10000,0,0,0,10001,60,1,10000,0),
 (7,5,5,0,10000,60,0,M,60),(M,M,M,0,10000,60,0,M,60),(M,M,0,0,10000,60,1,M,0),
]);
for (snap,prev,cur,ws,pct,period,amount,vb,now) in selloff_cases {let mut d=dyn_state(snap,prev,cur,ws);
let r=math::max_selloff::check_and_advance(&mut d,pct,period,amount,vb,now).map(|r|r.map(|r|vec![r.effective_selloff_before,r.effective_selloff,r.max_selloff_cap,r.vb_snapshot,r.previous_selloff,r.current_selloff,r.window_start_timestamp as u64]).unwrap_or_default());
println!("{{\"kind\":\"selloff\",\"snapshot\":\"{}\",\"previous\":\"{}\",\"current\":\"{}\",\"windowStart\":\"{}\",\"pct\":{},\"period\":{},\"amount\":\"{}\",\"vb\":\"{}\",\"now\":\"{}\",\"expected\":{}}}",snap,prev,cur,ws,pct,period,amount,vb,now,list(r));}
// (snapshot, previous, current, old_vb, new_vb) -> [snapshot', previous', current']
for (snap,prev,cur,old_vb,new_vb) in [(800_000u64,50_000u64,150_000u64,1_000_000u64,250_000u64),(950_000,47_500,95_000,950_000,475_000),(1,1,1,1000,1),(1,1,1,1,1000),(0,0,0,1,M),(1,M,1,1,2),(1,M,1,1,0),(5,2,3,0,1),(5,2,3,7,7),(10000,300,500,10000,15000),(3,1,2,3,2),(M,M,M,M,M-1),(1,1,1,M,1),(1_000_000,52_500,105_000,1_050_000,1_000_000)] {
let mut d=dyn_state(snap,prev,cur,100);let r=math::max_selloff::rescale_window_on_vb_change(&mut d,old_vb,new_vb).map(|_|vec![d.selloff_vb_snapshot,d.previous_selloff,d.current_selloff]);
println!("{{\"kind\":\"windowRescale\",\"snapshot\":\"{}\",\"previous\":\"{}\",\"current\":\"{}\",\"oldVb\":\"{}\",\"newVb\":\"{}\",\"expected\":{}}}",snap,prev,cur,old_vb,new_vb,list(r));}
for (snap,prev,cur,new_snap) in [(10000u64,300u64,500u64,15000u64),(3,1,2,2),(0,5,5,7),(7,1,1,7),(1,M,0,2),(1000,1,1,1),(M,M,M,1),(2,1,1,M)] {
let mut d=dyn_state(snap,prev,cur,100);let r=math::max_selloff::rebase_snapshot(&mut d,new_snap).map(|_|vec![d.selloff_vb_snapshot,d.previous_selloff,d.current_selloff]);
println!("{{\"kind\":\"windowRebase\",\"snapshot\":\"{}\",\"previous\":\"{}\",\"current\":\"{}\",\"newSnapshot\":\"{}\",\"expected\":{}}}",snap,prev,cur,new_snap,list(r));}
for (actual,ratio) in [(1_000_000u64,333_333_333_333_333_333u128),(3,333_333_333_333_333_333),(0,1_000_000_000_000_000_000),(M,1_000_000_000_000_000_000),(M,1_000_000_000_000_000_001),(7,142_857_142_857_142_857),(1,1),(1,0),(M,u128::MAX)] {
println!("{{\"kind\":\"depositCredit\",\"actual\":\"{}\",\"ratio\":\"{}\",\"expected\":{}}}",actual,ratio,value(PoolMath::calc_deposit_credit(actual,ratio)));}
for (vb,actual,credit,minted,supply) in [(5u64,4u64,1u64,100u64,1000u64),(1_000_000,1_000_000,1,1,1_000_000),(1000,0,0,500,1000),(1000,0,1,500,1000),(0,1,1,1,1),(1,1,1,1,0),(M,1,1,1,1),(M,M,0,0,1000),(1,M,M-1,1,1000),(7,3,1,0,1000),(1000,0,0,M-1000,1000),(1000,0,0,M,1000)] {
println!("{{\"kind\":\"vbAfterDeposit\",\"vb\":\"{}\",\"actual\":\"{}\",\"credit\":\"{}\",\"minted\":\"{}\",\"supply\":\"{}\",\"expected\":{}}}",vb,actual,credit,minted,supply,value(PoolMath::virtual_balance_after_deposit(vb,actual,credit,minted,supply)));}
for (vb,actual,payout,burned,supply) in [(7u64,5u64,1u64,100u64,1000u64),(1,10,9,1,1000),(100,10,10,1,1000),(1000,0,0,250,1000),(1000,0,0,1000,1000),(1000,5,6,1,10),(0,5,1,1,10),(5,5,1,0,0),(M,M,1,1,2),(M,M,M-1,1,2),(1000,0,0,0,1000),(3,7,2,1,2)] {
println!("{{\"kind\":\"vbAfterWithdrawal\",\"vb\":\"{}\",\"actual\":\"{}\",\"payout\":\"{}\",\"burned\":\"{}\",\"supply\":\"{}\",\"expected\":{}}}",vb,actual,payout,burned,supply,value(PoolMath::virtual_balance_after_withdrawal(vb,actual,payout,burned,supply)));}
for (requested,supply) in [(1u64,1000u64),(1,1001),(5000,1001),(1001,1001),(500,2000),(0,2000),(M,M),(1,0),(1000,1000),(999,1000)] {
println!("{{\"kind\":\"effectiveBurn\",\"requested\":\"{}\",\"supply\":\"{}\",\"expected\":{}}}",requested,supply,value(PoolMath::calc_effective_lp_burn(requested,supply)));}
for (amount,rate) in [(3998u64,1000u32),(1999,1000),(1,1),(0,1000),(M,1_000_000),(1_000_000,0),(123_456_789,3000),(M,1),(1_000_000,1_000_000),(999_999,1)] {
println!("{{\"kind\":\"swapFee\",\"amount\":\"{}\",\"rate\":{},\"expected\":{}}}",amount,rate,value(calculate_swap_fee(amount,rate)));}
for (fee,rate) in [(4u64,2000u16),(1,1),(0,2000),(10,10000),(12345,2000),(M,10000),(M,1),(5,2000),(4,2500),(1_000_000,3333)] {
println!("{{\"kind\":\"protocolFee\",\"fee\":\"{}\",\"rate\":{},\"expected\":{}}}",fee,rate,value(calculate_protocol_fee(fee,rate)));}
for decimals in [0u8,6,9,18] {println!("{{\"kind\":\"invariant\",\"decimals\":{},\"expected\":{}}}",decimals,value(math::weighted_math::WeightedMath::calculate_invariant(&[1_000_000_000,2_000_000_000],&[5000,5000],&[decimals,decimals])));}
let seeded=math::weighted_math::WeightedMath::calculate_invariant(&[3,3],&[5000,5000],&[0,0]).unwrap() as u64;
let mut supply=seeded;let mut acquired=0u64;
for round in 0..3 {
let (lp,ratio)=PoolMath::calc_lp_out_given_exact_tokens_in(&[3,3],&[1,1],&[0,0],supply).unwrap();
let credit=PoolMath::calc_deposit_credit(3,ratio).unwrap();
assert!(seeded>=1000 && lp>0 && credit<=1);
println!("{{\"kind\":\"joinRounding\",\"round\":{},\"supply\":\"{}\",\"expected\":[\"{}\",\"{}\",\"{}\"]}}",round,supply,ratio,lp,credit);
supply+=lp;acquired+=lp;
}
println!("{{\"kind\":\"joinRoundingExit\",\"supply\":\"{}\",\"acquired\":\"{}\",\"expected\":{}}}",supply,acquired,list(PoolMath::calc_tokens_out_given_lp_in(&[3,3],acquired,supply,&[0,0])));
// v6 join leg: ratio -> lp (floor) -> credit (ceil) -> virtual balance (ceil), then the exact exit floor.
for (actual,vb,amount,supply) in [([3u64,3u64],[5u64,5u64],[1u64,1u64],1000u64),([1_000_000,2_000_000],[3_000_000,5_000_000],[333_333,1_000_000],1_000_000_000),([4,0],[5,9],[1,0],1000),([1,M],[M,1],[1,M],M-1000),([1_000_000_000,1_000_000_000],[7_000_000_000,3],[1,1],1_000_000_000_000)] {
let r=(||->Result<Vec<u64>>{let (lp,ratio)=PoolMath::calc_lp_out_given_exact_tokens_in(&actual,&amount,&[0,0],supply)?;let mut out=vec![lp,(ratio/ONE_U) as u64,(ratio%ONE_U) as u64];
for i in 0..2 {let credit=if actual[i]>0 {PoolMath::calc_deposit_credit(actual[i],ratio)?} else {0};let next=PoolMath::virtual_balance_after_deposit(vb[i],actual[i],credit,lp,supply)?;out.push(credit);out.push(next);
let payout=if actual[i]>0 {credit} else {0};out.push(PoolMath::virtual_balance_after_withdrawal(next,actual[i]+credit,payout,lp,supply+lp)?);}
Ok(out)})();
println!("{{\"kind\":\"joinLegV6\",\"actual\":[\"{}\",\"{}\"],\"vb\":[\"{}\",\"{}\"],\"amount\":[\"{}\",\"{}\"],\"supply\":\"{}\",\"expected\":{}}}",actual[0],actual[1],vb[0],vb[1],amount[0],amount[1],supply,list(r));}
}
const ONE_U:u128=1_000_000_000_000_000_000;
'''
with tempfile.TemporaryDirectory(prefix='coffer-rust-math-') as tmp:
 tmp=pathlib.Path(tmp);(tmp/'reference.rs').write_text(preamble+mathmod+wrapper+main)
 subprocess.run(['rustc','--edition=2021','-O',str(tmp/'reference.rs'),'-o',str(tmp/'reference')],check=True)
 rows=[json.loads(line) for line in subprocess.check_output([str(tmp/'reference')],text=True).splitlines()]
meta={'contractBranch':'v6','contractCommit':subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),'sourceHashes':{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in [*sources.values(),SWAP]},'vectors':rows}
out=pathlib.Path(__file__).parent/'fixtures/deployed-v6-math.json';out.write_text(json.dumps(meta,indent=2)+'\n');print(f'Wrote {len(rows)} native Rust reference vectors to {out}')
