/** Compatibility refusal for saved pre-LCU workflows. Never invokes native input. */
export async function deepHookClick(pid: number, x: number, y: number): Promise<{ ok: boolean, message: string }> {
  return {ok:false,message:'Direct background AXPress is disabled. Office agents cannot touch user apps; Echo must use an approved fresh LCU target.'};
}
