import json,os,time,urllib.parse,requests
from playwright.sync_api import sync_playwright
U=os.environ["SUPABASE_URL"].rstrip("/");SK=os.environ["SUPABASE_SERVICE_ROLE_KEY"];PK=os.environ["SUPABASE_PUBLISHABLE_KEY"]
ref=urllib.parse.urlparse(U).hostname.split(".")[0];KEY=f"sb-{ref}-auth-token";M=f"DBG-{int(time.time())}"
ah={"apikey":SK,"Authorization":f"Bearer {SK}","Content-Type":"application/json"}
em=f"{M.lower()}@example.com"
uid=requests.post(f"{U}/auth/v1/admin/users",headers=ah,json={"email":em,"password":"Test-Passw0rd-123!","email_confirm":True}).json()["id"]
pid=requests.post(f"{U}/rest/v1/patients",headers={**ah,"Prefer":"return=representation"},json={"full_name":"A.G.","age":71,"status":"admitted","current_management":f"Initial {M}"}).json()[0]["id"]
sess=requests.post(f"{U}/auth/v1/token?grant_type=password",headers={"apikey":PK,"Content-Type":"application/json"},json={"email":em,"password":"Test-Passw0rd-123!"}).json()
with sync_playwright() as pw:
  b=pw.chromium.launch(headless=True);c=b.new_context(viewport={"width":1280,"height":1800});p=c.new_page()
  errs=[];p.on("console",lambda m: errs.append(f"{m.type}:{m.text}"))
  p.goto("http://localhost:8080");p.evaluate("([k,v])=>localStorage.setItem(k,v)",[KEY,json.dumps(sess)])
  p.goto(f"http://localhost:8080/patients/{pid}",wait_until="domcontentloaded")
  time.sleep(20)
  p.screenshot(path="tests/e2e/screenshots/dbg_detail.png")
  print("URL",p.url)
  open("tests/e2e/_body.txt","w").write(p.inner_text("body"))
  print("ERRS", [e for e in errs if 'error' in e.lower()][:10])
  b.close()
requests.delete(f"{U}/rest/v1/patients?id=eq.{pid}",headers=ah);requests.delete(f"{U}/auth/v1/admin/users/{uid}",headers=ah)
