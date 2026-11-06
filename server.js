import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import pg from "pg";
import { randomUUID } from "node:crypto";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:true,credentials:true}});
const PORT=process.env.PORT||3000;
app.use(express.json({limit:"2mb"}));

let db=null;
if(process.env.DATABASE_URL){
  db=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL.includes("localhost")?false:{rejectUnauthorized:false}});
  db.query("SELECT 1").then(()=>console.log("[IUFYE] PostgreSQL connected")).catch(err=>console.error("[IUFYE] PostgreSQL connection failed:",err.message));
}

app.get("/api/health",async(_req,res)=>{
  let database="not_configured";
  if(db){try{await db.query("SELECT 1");database="connected";}catch{database="error";}}
  res.json({ok:true,app:"IUFYE",database,timestamp:new Date().toISOString()});
});

io.on("connection",socket=>{
  socket.emit("iufye:ready",{connected:true});
  socket.on("chat:join",room=>{if(typeof room==="string"&&room.length<=100)socket.join(room);});
  socket.on("chat:message",payload=>{
    if(!payload||typeof payload.text!=="string")return;
    const text=payload.text.trim().slice(0,4000);if(!text)return;
    const message={id:randomUUID(),text,createdAt:new Date().toISOString()};
    if(typeof payload.room==="string"&&payload.room.length<=100)io.to(payload.room).emit("chat:message",message);
  });
});

app.use(express.static(path.join(__dirname,"dist")));
app.get("*",(_req,res)=>res.sendFile(path.join(__dirname,"dist","index.html")));
server.listen(PORT,"0.0.0.0",()=>console.log(`[IUFYE] Server listening on ${PORT}`));