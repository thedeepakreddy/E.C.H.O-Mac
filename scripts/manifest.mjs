import ts from 'typescript';
/** JSON.parse silently overwrites duplicate keys. Check the source tree first. */
export function parseUniqueJson(source){
 const value=JSON.parse(source);
 const ast=ts.parseJsonText('manifest.json',source);
 function visit(node,path){
  if(ts.isObjectLiteralExpression(node)){
   const seen=new Set();
   for(const property of node.properties){
    const key=property.name.text,next=path?`${path}.${key}`:key;
    if(seen.has(key))throw Error(`Duplicate JSON key: ${next}`);
    seen.add(key);visit(property.initializer,next);
   }
  }else if(ts.isArrayLiteralExpression(node))node.elements.forEach((element,index)=>visit(element,`${path}[${index}]`));
 }
 for(const statement of ast.statements)if(ts.isExpressionStatement(statement))visit(statement.expression,'');
 return value;
}
