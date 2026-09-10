import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "shikshasetu-dev-secret-change-me";
const DB_FILE = process.env.AUTH_DB || path.join(__dirname, "data", "users.json");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({users:[]}, null, 2));
const readDB = () => JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
const writeDB = db => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const safeUser = u => ({id:u.id,name:u.name,email:u.email});
const tokenFor = u => jwt.sign({sub:u.id,email:u.email,name:u.name}, JWT_SECRET, {expiresIn:"7d"});
const emailValid = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e||""));

const app = express();
app.use(cors()); app.use(express.json());

async function sendResetEmail(to, resetUrl) {
  if (!process.env.SMTP_HOST) return false;
  const transporter = nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE === "true",auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}});
  await transporter.sendMail({from:process.env.SMTP_FROM || process.env.SMTP_USER,to,subject:"Reset your ShikshaSetu AI password",text:`Reset your password: ${resetUrl}\nThis link expires in 30 minutes.`});
  return true;
}

app.get("/api/health", (_req,res)=>res.json({ok:true,service:"ShikshaSetu AI backend",auth:"jwt"}));
app.post("/api/auth/signup", async (req,res)=>{
  const {name,email,password}=req.body||{};
  if (!name?.trim() || !emailValid(email) || String(password||"").length < 8) return res.status(400).json({error:"Enter a name, valid email and password with at least 8 characters."});
  const db=readDB(), normalized=email.toLowerCase().trim();
  if (db.users.some(u=>u.email===normalized)) return res.status(409).json({error:"An account with this email already exists."});
  const user={id:crypto.randomUUID(),name:name.trim(),email:normalized,passwordHash:await bcrypt.hash(password,12),createdAt:new Date().toISOString()};
  db.users.push(user); writeDB(db); res.status(201).json({token:tokenFor(user),user:safeUser(user)});
});
app.post("/api/auth/login", async (req,res)=>{
  const {email,password}=req.body||{}; const db=readDB(); const user=db.users.find(u=>u.email===String(email||"").toLowerCase().trim());
  if (!user || !(await bcrypt.compare(String(password||""),user.passwordHash))) return res.status(401).json({error:"Invalid email or password."});
  res.json({token:tokenFor(user),user:safeUser(user)});
});
app.get("/api/auth/me", (req,res)=>{ try { const p=jwt.verify((req.headers.authorization||"").replace(/^Bearer\s+/i,""),JWT_SECRET); const u=readDB().users.find(x=>x.id===p.sub); if(!u) throw Error(); res.json({user:safeUser(u)}); } catch { res.status(401).json({error:"Unauthorized"}); }});
app.post("/api/auth/forgot-password", async (req,res)=>{
  const email=String(req.body?.email||"").toLowerCase().trim(); if(!emailValid(email)) return res.status(400).json({error:"Enter a valid email address."});
  const db=readDB(), user=db.users.find(u=>u.email===email); // Avoid account enumeration.
  if(!user) return res.json({message:"If an account exists, a password reset link has been sent."});
  const raw=crypto.randomBytes(32).toString("hex"); user.resetTokenHash=crypto.createHash("sha256").update(raw).digest("hex"); user.resetExpires=Date.now()+30*60*1000; writeDB(db);
  const base=process.env.FRONTEND_URL || "http://localhost:5173"; const resetUrl=`${base}/reset-password?token=${raw}&email=${encodeURIComponent(email)}`;
  let sent=false; try { sent=await sendResetEmail(email,resetUrl); } catch (e) { console.error("SMTP error",e.message); }
  res.json({message:"If an account exists, a password reset link has been sent.", ...(process.env.NODE_ENV !== "production" && !sent ? {resetUrl}: {})});
});
app.post("/api/auth/reset-password", async (req,res)=>{
  const {email,token,password}=req.body||{}; if(!emailValid(email)||!token||String(password||"").length<8) return res.status(400).json({error:"Invalid reset details. Password must be at least 8 characters."});
  const db=readDB(), hash=crypto.createHash("sha256").update(token).digest("hex"), user=db.users.find(u=>u.email===String(email).toLowerCase().trim() && u.resetTokenHash===hash && u.resetExpires>Date.now());
  if(!user) return res.status(400).json({error:"This reset link is invalid or expired."});
  user.passwordHash=await bcrypt.hash(password,12); delete user.resetTokenHash; delete user.resetExpires; writeDB(db); res.json({message:"Password updated successfully. You can sign in now."});
});

const languageNames={hindi:"Hindi",english:"English",santhali:"Santhali",mundari:"Mundari",ho:"Ho"};
const demoLessons={plants:{topic:"Why plants need sunlight",explanation:"Plants need sunlight to make their own food. Sunlight gives plants the energy they need to grow healthy.",localExample:"Think about crops growing in a field. Without enough sunlight, plants cannot grow properly.",question:"What do plants need from the Sun?",options:["Water","Sunlight","A pencil"],answer:"Sunlight"},water:{topic:"Why water is important",explanation:"Water is needed by people, animals and plants. It helps living things grow and stay healthy.",localExample:"Farmers give water to crops so the plants can grow.",question:"Which living things need water?",options:["Only plants","Only people","People, animals and plants"],answer:"People, animals and plants"},default:{topic:"Learning through simple examples",explanation:"Let's understand the idea using a simple example from everyday life. Small examples can make difficult lessons easier to understand.",localExample:"Connect the lesson to things children see at home, school or in their village.",question:"How can an example help us learn?",options:["It makes ideas easier","It makes learning impossible","It removes the lesson"],answer:"It makes ideas easier"}};
function detectLesson(text=""){const t=text.toLowerCase();if(t.includes("plant")||t.includes("sunlight")||t.includes("photosynthesis"))return demoLessons.plants;if(t.includes("water"))return demoLessons.water;return demoLessons.default;}
function demoTranslation(text,language){const lesson=detectLesson(text),lang=languageNames[language]||language;const translations={santhali:{plants:"Hor do suruj ren alo ar da katha re jibon akat te lagit.",water:"Daka jibon lagit khub gurutpurna kana."},mundari:{plants:"Singi hor ko alo ar pani re badha lagit jaruri kana.",water:"Daka jibon re bahut jaruri kana."},ho:{plants:"Bir ko suruj ren alo re badha ar jibon lagit jaruri kana.",water:"Daka jibon lagit jaruri kana."}};const key=lesson===demoLessons.plants?"plants":lesson===demoLessons.water?"water":null;if(key&&translations[language])return translations[language][key];return `[${lang} demo translation] ${text}`;}
app.post("/api/translate",(req,res)=>{const{text,targetLanguage="santhali"}=req.body||{};if(!text?.trim())return res.status(400).json({error:"Text is required."});res.json({original:text.trim(),targetLanguage:languageNames[targetLanguage]||targetLanguage,translated:demoTranslation(text.trim(),targetLanguage),confidence:94,demo:true,note:"Prototype translation response. Connect a validated language model for production."});});
app.post("/api/lesson",(req,res)=>{const{text,grade="Class 3",targetLanguage="santhali"}=req.body||{};res.json({grade,language:languageNames[targetLanguage]||targetLanguage,...detectLesson(text||""),demo:true});});
app.post("/api/quiz",(req,res)=>{const{answer,expected="Sunlight"}=req.body||{},correct=String(answer||"").trim().toLowerCase()===String(expected).trim().toLowerCase();res.json({correct,score:correct?100:35,feedback:correct?"Great job! You understood the concept.":`Good try. The expected answer is ${expected}.`});});
app.listen(PORT,"0.0.0.0",()=>console.log(ShikshaSetu backend running on port ${PORT}));
