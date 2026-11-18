import { createHmac,timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
const cookieName="gta_radar_session";
const key=()=>{const pass=process.env.ADMIN_PASSWORD;const secret=process.env.SESSION_SECRET;if(!pass||!secret||secret.length<32)return null;return createHmac("sha256",secret).update("gta-radar:"+pass).digest("hex")};
const equal=(a:string,b:string)=>{const x=Buffer.from(a,"utf8"),y=Buffer.from(b,"utf8");return x.length===y.length&&timingSafeEqual(x,y)};
export const configured=()=>Boolean(key());
export async function authorized(){const expected=key();if(!expected)return false;const actual=(await cookies()).get(cookieName)?.value??"";return equal(actual,expected)}
export function validPassword(password:string){const expected=process.env.ADMIN_PASSWORD??"";return !!key()&&equal(password,expected)}
export async function login(){const v=key();if(!v)throw Error("Configuração ausente");(await cookies()).set(cookieName,v,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:604800})}
export async function logout(){(await cookies()).delete(cookieName)}
