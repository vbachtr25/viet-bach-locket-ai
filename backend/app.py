import io, os, uuid, base64
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps, ImageDraw
import httpx

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'generated'; OUT.mkdir(exist_ok=True)
app=FastAPI(title='Viet Bach Locket AI')
app.add_middleware(CORSMiddleware,allow_origins=os.getenv('ALLOWED_ORIGINS','http://localhost:8000,http://127.0.0.1:8000').split(','),allow_methods=['GET','POST'],allow_headers=['*'])
MAX=8*1024*1024
async def read_image(file):
    b=await file.read(MAX+1)
    if len(b)>MAX: raise HTTPException(413,'Ảnh tối đa 8 MB')
    try:
        im=Image.open(io.BytesIO(b)); im.load()
        if im.width*im.height>25000000: raise ValueError('too large')
        return ImageOps.exif_transpose(im).convert('RGB')
    except Exception: raise HTTPException(400,'Ảnh không hợp lệ')
def save(im):
    name=uuid.uuid4().hex+'.png'; im.save(OUT/name,'PNG'); return '/generated/'+name
@app.get('/health')
def health(): return {'ok':True,'ai_configured':bool(os.getenv('OPENAI_API_KEY'))}
@app.get('/')
def index(): return FileResponse(ROOT/'web/index.html')
@app.get('/generated/{name}')
def generated(name:str):
    if not name.endswith('.png') or len(name)!=36 or not all(c in '0123456789abcdef' for c in name[:-4]): raise HTTPException(404)
    path=OUT/name
    if not path.exists(): raise HTTPException(404)
    return FileResponse(path,media_type='image/png',headers={'Cache-Control':'no-store'})
@app.post('/api/photobooth')
async def photobooth(files:list[UploadFile]=File(...),theme:str=Form('pink')):
    if not 1<=len(files)<=4: raise HTTPException(400,'Chọn 1–4 ảnh')
    ims=[await read_image(f) for f in files]
    colors={'pink':('#ffe7f0','#d13d78'),'cream':('#fff1d6','#a06a34'),'dark':('#181624','#f6d8ff')}
    bg,fg=colors.get(theme,colors['pink'])
    w,h,gap,pad=480,570,24,48
    sheet=Image.new('RGB',(w*2+gap+pad*2,h*2+gap+pad*2+110),bg)
    draw=ImageDraw.Draw(sheet)
    for i in range(4):
        pic=ImageOps.fit(ims[i%len(ims)],(w,h),method=Image.Resampling.LANCZOS)
        x=pad+(i%2)*(w+gap); y=pad+(i//2)*(h+gap)
        sheet.paste(pic,(x,y)); draw.rounded_rectangle((x-3,y-3,x+w+3,y+h+3),radius=12,outline=fg,width=5)
    draw.text((pad,2*h+gap+pad+28),'VIET BACH  •  PHOTOBOOTH',fill=fg)
    return {'image_url':save(sheet),'mode':'four_distinct' if len(ims)==4 else 'repeated_sources','count':len(ims)}
@app.post('/api/ai-filter')
async def ai_filter(file:UploadFile=File(...),prompt:str=Form(...)):
    key=os.getenv('OPENAI_API_KEY')
    if not key: raise HTTPException(503,'Chưa cấu hình OPENAI_API_KEY')
    if not 3<=len(prompt)<=500: raise HTTPException(400,'Prompt phải dài 3–500 ký tự')
    im=await read_image(file)
    buf=io.BytesIO(); im.save(buf,format='PNG'); buf.seek(0)
    model=os.getenv('OPENAI_IMAGE_MODEL','gpt-image-1')
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            r=await client.post('https://api.openai.com/v1/images/edits',headers={'Authorization':'Bearer '+key},data={'model':model,'prompt':prompt},files={'image':('input.png',buf,'image/png')})
            if r.status_code!=200: raise HTTPException(502,'Nhà cung cấp AI trả lỗi; kiểm tra model/quota/API key')
            result=r.json()['data'][0]
            if 'b64_json' not in result: raise HTTPException(502,'AI không trả ảnh base64')
            output=Image.open(io.BytesIO(base64.b64decode(result['b64_json']))).convert('RGB')
            return {'image_url':save(output)}
    except httpx.RequestError: raise HTTPException(502,'Không kết nối được dịch vụ AI')
