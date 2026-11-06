import { useMemo, useState } from "react";
import { Search, Pencil, MoreHorizontal, Paperclip, Smile, Mic, Send, Phone, Video, Info, Image as ImageIcon, FileText, Bell, Settings, Users, Bookmark, Archive, ChevronLeft, CheckCheck, X } from "lucide-react";

type Chat = { id:number; name:string; handle:string; avatar:string; color:string; message:string; time:string; unread:number; online?:boolean };
type Message = { id:number; mine:boolean; text:string; time:string };

const initialChats:Chat[] = [
  {id:1,name:"Александр",handle:"@alex",avatar:"А",color:"violet",message:"Да, отлично. Тогда до завтра!",time:"14:32",unread:2,online:true},
  {id:2,name:"Команда IUFYE",handle:"12 участников",avatar:"I",color:"blue",message:"Мария: отправила макет",time:"13:58",unread:5},
  {id:3,name:"Мама",handle:"@mom",avatar:"М",color:"rose",message:"Не забудь позвонить ❤️",time:"12:41",unread:0,online:true},
  {id:4,name:"Дизайн и идеи",handle:"канал",avatar:"✳",color:"amber",message:"Новый пост · 3 минуты",time:"11:20",unread:0},
  {id:5,name:"Даниил",handle:"@dan",avatar:"Д",color:"green",message:"скинул тебе файл",time:"Вчера",unread:0},
  {id:6,name:"Избранное",handle:"личное хранилище",avatar:"★",color:"slate",message:"Заметки и сохранённые сообщения",time:"Пн",unread:0}
];
const starterMessages:Message[] = [
  {id:1,mine:false,text:"Привет! Как тебе новый интерфейс?",time:"14:25"},
  {id:2,mine:true,text:"Выглядит очень хорошо. Особенно тёмная тема.",time:"14:27"},
  {id:3,mine:false,text:"Спасибо! Хочу ещё немного доработать список чатов.",time:"14:29"},
  {id:4,mine:true,text:"Давай, можем обсудить детали здесь.",time:"14:32"}
];

export default function App() {
  const [chats,setChats] = useState(initialChats);
  const [active,setActive] = useState(1);
  const [query,setQuery] = useState("");
  const [draft,setDraft] = useState("");
  const [messages,setMessages] = useState<Message[]>(starterMessages);
  const [mobileChat,setMobileChat] = useState(false);
  const [showProfile,setShowProfile] = useState(false);
  const [showNewChat,setShowNewChat] = useState(false);
  const [notice,setNotice] = useState("");
  const current = chats.find(c=>c.id===active) ?? chats[0];
  const filtered = useMemo(()=>chats.filter(c=>(c.name+c.message+c.handle).toLowerCase().includes(query.toLowerCase())),[chats,query]);

  function sendMessage() {
    const value=draft.trim(); if(!value)return;
    const time=new Date().toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
    setMessages(prev=>[...prev,{id:Date.now(),mine:true,text:value,time}]);
    setDraft("");
    setChats(prev=>prev.map(c=>c.id===active?{...c,message:value,time:"Сейчас"}:c));
  }
  function selectChat(chat:Chat) {
    setActive(chat.id); setMobileChat(true);
    setMessages(chat.id===1?starterMessages:[{id:chat.id*10,mine:false,text:chat.message,time:chat.time}]);
    setChats(prev=>prev.map(c=>c.id===chat.id?{...c,unread:0}:c));
  }

  return <main className="app-shell">
    <aside className={`sidebar ${mobileChat?"mobile-hidden":""}`}>
      <div className="side-top">
        <button className="icon-button" aria-label="Меню" onClick={()=>setShowProfile(!showProfile)}><MoreHorizontal size={21}/></button>
        <div className="brand"><span className="brand-mark">i</span><span>IUFYE</span></div>
        <button className="icon-button" aria-label="Новый чат" onClick={()=>setShowNewChat(true)}><Pencil size={18}/></button>
      </div>
      <div className="search-wrap"><Search size={17}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Поиск"/><kbd>⌘ K</kbd></div>
      <div className="filter-row"><button className="filter active">Все чаты</button><button className="filter">Личные</button><button className="filter">Группы</button></div>
      <div className="chat-list">{filtered.map(chat=><button key={chat.id} className={`chat-item ${active===chat.id?"selected":""}`} onClick={()=>selectChat(chat)}>
        <span className={`avatar ${chat.color}`}>{chat.avatar}{chat.online&&<i className="online-dot"/>}</span>
        <span className="chat-copy"><span className="chat-line"><strong>{chat.name}</strong><time>{chat.time}</time></span><span className="chat-line preview"><span>{chat.message}</span>{chat.unread>0&&<b className="unread">{chat.unread}</b>}</span></span>
      </button>)}{filtered.length===0&&<div className="empty-search">Ничего не найдено</div>}</div>
      <div className="sidebar-bottom">
        <button onClick={()=>setNotice("Раздел контактов скоро появится")}><Users size={18}/><span>Контакты</span></button>
        <button onClick={()=>setNotice("Настройки скоро появятся")}><Settings size={18}/><span>Настройки</span></button>
        <button onClick={()=>setNotice("Избранное находится в списке чатов")}><Bookmark size={18}/><span>Избранное</span></button>
        <div className="user-mini" onClick={()=>setShowProfile(true)}><span className="avatar small violet">D</span><span><b>Мой профиль</b><small>В сети</small></span><MoreHorizontal size={18}/></div>
      </div>
    </aside>
    <section className={`conversation ${mobileChat?"mobile-visible":""}`}>
      <header className="conversation-header">
        <button className="icon-button back-button" onClick={()=>setMobileChat(false)} aria-label="Назад"><ChevronLeft/></button>
        <span className={`avatar header-avatar ${current.color}`}>{current.avatar}</span>
        <button className="person-heading" onClick={()=>setShowProfile(true)}><strong>{current.name}</strong><small>{current.online?"в сети":current.handle}</small></button>
        <div className="header-actions">
          <button className="icon-button" aria-label="Аудиозвонок" onClick={()=>setNotice("Звонки появятся в следующем обновлении")}><Phone size={19}/></button>
          <button className="icon-button" aria-label="Видеозвонок" onClick={()=>setNotice("Видеозвонки появятся в следующем обновлении")}><Video size={20}/></button>
          <button className="icon-button" aria-label="Информация" onClick={()=>setShowProfile(true)}><Info size={19}/></button>
        </div>
      </header>
      <div className="message-area"><div className="date-pill">Сегодня</div>
        {messages.map(m=><div key={m.id} className={`message-row ${m.mine?"mine":""}`}><div className="bubble">{m.text}<span className="message-meta">{m.time}{m.mine&&<CheckCheck size={14}/>}</span></div></div>)}
        <div className="encryption-note">🔒 Сообщения пока работают в демонстрационном режиме. Реальные аккаунты и синхронизация — следующий этап.</div>
      </div>
      <div className="composer">
        <button className="icon-button" aria-label="Прикрепить файл" onClick={()=>setNotice("Загрузка файлов будет подключена следующим этапом")}><Paperclip size={21}/></button>
        <input value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendMessage()} placeholder="Сообщение..."/>
        <button className="icon-button" aria-label="Эмодзи" onClick={()=>setDraft(v=>v+"🙂")}><Smile size={21}/></button>
        {draft.trim()?<button className="send-button" onClick={sendMessage} aria-label="Отправить"><Send size={18}/></button>:<button className="icon-button" aria-label="Голосовое сообщение" onClick={()=>setNotice("Голосовые сообщения появятся позже")}><Mic size={21}/></button>}
      </div>
    </section>
    {showProfile&&<div className="overlay" onClick={()=>setShowProfile(false)}><section className="profile-panel" onClick={e=>e.stopPropagation()}>
      <button className="close-button" onClick={()=>setShowProfile(false)}><X/></button><span className={`avatar profile-avatar ${current.color}`}>{current.avatar}</span><h2>{current.name}</h2><p>{current.handle}</p>
      <div className="profile-actions"><button onClick={()=>setNotice("Уведомления скоро появятся")}><Bell/>Уведомления</button><button onClick={()=>setNotice("Медиафайлы скоро появятся")}><ImageIcon/>Медиафайлы</button><button onClick={()=>setNotice("Файлы скоро появятся")}><FileText/>Файлы</button><button onClick={()=>setNotice("Архив скоро появится")}><Archive/>Архив</button></div>
    </section></div>}
    {showNewChat&&<div className="overlay" onClick={()=>setShowNewChat(false)}><section className="new-chat-panel" onClick={e=>e.stopPropagation()}>
      <button className="close-button" onClick={()=>setShowNewChat(false)}><X/></button><h2>Новое сообщение</h2><p>Поиск контактов появится после подключения аккаунтов.</p><div className="search-wrap"><Search size={17}/><input placeholder="Имя пользователя или номер"/></div>
    </section></div>}
    {notice&&<div className="toast" onClick={()=>setNotice("")}>{notice}<button><X size={15}/></button></div>}
  </main>;
}