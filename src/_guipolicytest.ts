import assert from 'node:assert/strict';
import {calculatorResultMatches,isCalculatorReference} from './tools/gui-completion-policy.js';

/** Review baseline only; never imported by runtime code. */
function legacyCalculatorResultMatches(actual:string,expected:number):boolean {
  const value=Number(actual.replace(/,/g,''));
  return Math.abs(value-expected)<=8*Number.EPSILON*Math.max(1,Math.abs(value),Math.abs(expected));
}

const numericCases:Array<[string,number,boolean]>=[
  ['0,5',5,false],
  ['1000000000000000',1e15+1,false],
  ['0,5',0.5,false],
  ['1,000',1000,false],
  ['1,234.5',1234.5,false],
  ['12,34',1234,false],
  ['1 000',1000,false],
  ['1\u00a0000',1000,false],
  ['1_000',1000,false],
  ['0x10',16,false],
  ['',0,false],
  ['   ',0,false],
  ['NaN',5,false],
  ['Infinity',Infinity,false],
  ['-Infinity',-Infinity,false],
  ['5',NaN,false],
  ['5',Infinity,false],
  ['Result: 5',5,false],
  ['5 apples',5,false],
  ['5\n6',5,false],
  ['5',5,true],
  ['  +5.00  ',5,true],
  ['.5e1',5,true],
  ['50e-1',5,true],
  ['5.',5,true],
  ['-5.0',-5,true],
  ['-0',0,true],
  ['0e9999',0,true],
  ['5.0000000000001',5,false],
  ['5.0000000000000000001',5,false],
  ['1000000000000001',1e15+1,true],
  ['1000000000000001.0000000000001',1e15+1,false],
  ['9007199254740991',Number.MAX_SAFE_INTEGER,true],
  ['-9007199254740991',Number.MIN_SAFE_INTEGER,true],
  ['9007199254740992',Number.MAX_SAFE_INTEGER+1,false],
  ['-9007199254740992',Number.MIN_SAFE_INTEGER-1,false],
  ['1e20',1e20,false],
  ['0.3',0.1+0.2,true],
  ['0.30000000000000004',0.3,true],
  ['3e-1',0.1+0.2,true],
  ['-.3',-0.3,true],
  ['.500000000001',0.5,false],
  ['.499999999999',0.5,false],
  ['.5000000000005',0.5,true],
  ['.4999999999995',0.5,true],
  ['.50000000000051',0.5,false],
  ['.49999999999949',0.5,false],
  ['.5000000000011',0.5,false],
  ['.4999999999989',0.5,false],
  ['1.25E+2',125,true],
  ['1.25e-2',0.0125,true],
  ['1000000000.125',1000000000.125,true],
  ['1000000000.12500001',1000000000.125,false],
  ['1000000000000000.1',1000000000000000.25,false],
  ['1e309',0.5,false],
  ['1e-1000',0,false],
  ['1e-1000',Number.MIN_VALUE,false],
  ['5e-324',Number.MIN_VALUE,true],
  ['0',1e-15,false],
  ['1e-15',2e-15,false],
  ['0',-1e-15,false],
  ['-1e-15',-1e-15,true],
  ['1.000000000001e-15',1e-15,true],
  ['1.0000000000011e-15',1e-15,false],
  ['0',Number.MIN_VALUE,false],
  ['4.9e-324',Number.MIN_VALUE,false],
  ['4.999999999995e-324',Number.MIN_VALUE,true],
  ['4.999999999994e-324',Number.MIN_VALUE,false],
  ['5e-324',0,false],
  ['2.500000000001',2.5,true],
  ['2.5000000000011',2.5,false],
  ['0'.repeat(257),0,false],
];
const failures:string[]=[];
const baseline=process.argv.includes('--baseline');
const matches=baseline?legacyCalculatorResultMatches:calculatorResultMatches;
for(const [actual,expected,wanted] of baseline?numericCases.slice(0,2):numericCases) {
  const result=matches(actual,expected);
  if(result!==wanted)failures.push(`${JSON.stringify(actual)} versus ${expected}: got ${result}, expected ${wanted}`);
}
assert.deepEqual(failures,[],'review numeric false positives must be rejected');
const referenceCases:Array<[string,boolean]>=[
  ['Calculator',true],
  ['calculator',true],
  ['CALCULATOR',true],
  ['  Calculator  ',true],
  ['com.apple.calculator',true],
  ['COM.APPLE.CALCULATOR',true],
  ['/System/Applications/Calculator.app',true],
  ['',false],
  ['Calculator.app',false],
  ['My Calculator',false],
  ['com.apple.calculator.other',false],
  ['/Applications/Calculator.app',false],
  ['/tmp/Calculator.app',false],
  ['/System/Applications/calculator.app',false],
  ['/System/Applications/Calculator.app/',false],
  ['/System/Applications/../Applications/Calculator.app',false],
  ['file:///System/Applications/Calculator.app',false],
];
for(const [reference,wanted] of referenceCases)assert.equal(isCalculatorReference(reference),wanted,reference);
console.log(`${numericCases.length} numeric and ${referenceCases.length} reference GUI completion policy cases passed`);
