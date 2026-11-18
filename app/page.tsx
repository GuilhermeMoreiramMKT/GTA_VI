import {authorized,configured} from "../lib/security";import Dashboard from "./dashboard";import Login from "./login";
export const dynamic="force-dynamic";
export default async function Page(){return await authorized()?<Dashboard/>:<Login ready={configured()}/>}
