import json,os,time,urllib.parse,requests
from playwright.sync_api import sync_playwright
U=os.environ["SUPABASE_URL"].rstrip("/");SK=os.environ["SUPABASE_SERVICE_ROLE_KEY"];PK=os.environ["SUPABASE_PUBLISHABLE_KEY"]
ref=urllib.parse.urlparse(U).hostname.split(".")[0];KEY=f"sb-{ref}-auth-token";M=f"DBG2-{int(time.time())}"
ah={"apikey":SK,"Authorization":f"Bearer {SK}","Content-Type":"application/json"}
em=f"{M.lower()}@example.com"
uid=requests.post(f"{U}/auth/v1/admin/users",headers=ah,json={"email":em,"password":"Test-Passw0rd-123!","email_confirm":True}).json()["id"]
requests.post(f"{U}/rest/v1/user_roles",headers=ah,json={"user_id":uid,"role":"clinician"})
pid=requests.post(f"{U}/rest/v1/patients",headers={**ah,"Prefer":"return=representation"},json={"full_name":"A.G.","age":71,"status":"admitted","current_management":f"Initial {M}"}).json()[0]["id"]
sess=requests.post(f"{U}/auth/v1/token?grant_type=password",headers={"apikey":PK,"Content-Type":"application/json"},json={"email":em,"password":"Test-Passw0rd-123!"}).json()
MOD="/src/lib/patients.functions.ts"
try:
  with sync_playwright() as pw:
    b=pw.chromium.launch(headless=True);c=b.new_context(viewport={"width":1280,"height":1800});p=c.new_page()
    p.goto("http://localhost:8080",wait_until="domcontentloaded")
    # logged-out call
    out=p.evaluate("""async (arg)=>{const m=await import(arg.mod);try{const r=await m.getPatient({data:{id:arg.pid}});return {ok:true,r};}catch(e){return {ok:false,err:String(e&&e.message||e)};}}""",{"mod":MOD,"pid":pid})
    print("LOGGED-OUT getPatient:",json.dumps(out)[:300])
    # authenticate
    p.evaluate("([k,v])=>localStorage.setItem(k,v)",[KEY,json.dumps(sess)])
    p.reload(wait_until="domcontentloaded");time.sleep(1)
    got=p.evaluate("""async (arg)=>{const m=await import(arg.mod);const r=await m.getPatient({data:{id:arg.pid}});return r;}""",{"mod":MOD,"pid":pid})
    print("AUTHED getPatient current_management:",got.get("current_management") if isinstance(got,dict) else got)
    upd=p.evaluate("""async (arg)=>{const m=await import(arg.mod);const r=await m.updatePatient({data:{id:arg.pid, current_management:arg.v, updated_at:arg.ua}});return r;}""",{"mod":MOD,"pid":pid,"v":f"Edited {M}","ua":got.get("updated_at")})
    print("AUTHED updatePatient current_management:",upd.get("current_management") if isinstance(upd,dict) else str(upd)[:200])
    b.close()
finally:
  requests.delete(f"{U}/rest/v1/patients?id=eq.{pid}",headers=ah);requests.delete(f"{U}/auth/v1/admin/users/{uid}",headers=ah)
