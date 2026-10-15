const DECIMAL=/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const MAX_RESULT_CHARACTERS=256;

/** Decimal coefficients preserve digits that Number parsing would round away. */
function decimalParts(text:string):{coefficient:bigint;scale:number}|null {
  if(!text || text.length>MAX_RESULT_CHARACTERS)return null;
  const match=DECIMAL.exec(text);
  if(!match)return null;
  const value=Number(text);
  if(!Number.isFinite(value) || (Number.isInteger(value)&&!Number.isSafeInteger(value)))return null;
  const fraction=match[3]??match[4]??'';
  const digits=BigInt((match[2]??'0')+fraction);
  if(value===0&&digits!==0n)return null; // Nonzero underflow is not a displayed zero.
  if(digits===0n)return {coefficient:0n,scale:0};
  const scale=Number(match[5]??0)-fraction.length;
  if(!Number.isSafeInteger(scale))return null;
  return {coefficient:match[1]==='-'?-digits:digits,scale};
}

/**
 * Plain decimal/scientific displays only: commas, grouping and labels are rejected.
 * Safe-integer targets must match exactly. Fractional targets compare against
 * expected's canonical decimal representation with tolerance
 * min(1e-12, abs(expected canonical decimal) * 1e-12), evaluated with BigInt
 * decimal scales to avoid underflow. Nonfinite/unsafe integers fail closed.
 */
export function calculatorResultMatches(actual:string,expected:number):boolean {
  if(!Number.isFinite(expected) || (Number.isInteger(expected)&&!Number.isSafeInteger(expected)))return false;
  const observed=decimalParts(actual.trim()),target=decimalParts(expected.toString());
  if(!observed || !target)return false;
  const integer=Number.isInteger(expected),scale=Math.min(observed.scale,target.scale,integer?0:Math.min(-12,target.scale-12));
  const difference=observed.coefficient*10n**BigInt(observed.scale-scale)-target.coefficient*10n**BigInt(target.scale-scale);
  if(integer)return difference===0n;
  const absoluteLimit=10n**BigInt(-12-scale);
  const relativeLimit=(target.coefficient<0n?-target.coefficient:target.coefficient)*10n**BigInt(target.scale-12-scale);
  return (difference<0n?-difference:difference)<=(absoluteLimit<relativeLimit?absoluteLimit:relativeLimit);
}

/** Recognized names/IDs are case-insensitive; the sole accepted app path is exact. */
export function isCalculatorReference(reference:string):boolean {
  const value=reference.trim();
  return /^(?:calculator|com\.apple\.calculator)$/i.test(value) || value==='/System/Applications/Calculator.app';
}
