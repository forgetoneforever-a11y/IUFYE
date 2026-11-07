import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Search, Pencil, MoreHorizontal, Paperclip, Smile, Mic, Send, Phone, Video, Info, Image as ImageIcon, FileText, Bell, Settings, Users, Bookmark, Archive, ChevronLeft, CheckCheck, X } from "lucide-react";

type Chat = { id:string; type:"direct"|"group"; name:string; handle:string; avatar:string; color:string; message:string; time:string; unread:number; online?:boolean };
type Message = { id:string; mine:boolean; text:string; time:string; sender?:string };
type Account = { id:string; email:string|null; phone:string|null; username:string; display_name?:string; bio?:string; avatar_url?:string|null; status_text?:string };

const initialChats:Chat[] = [];
const starterMessages:Message[] = [];

export default function App() {
  const [authUser,setAuthUser] = useState<Account|null>(null);
  const [authLoading,setAuthLoading] = useState(true);
  const [authChannel,setAuthChannel] = useState<"email"|"phone">("email");
  const [authDestination,setAuthDestination] = useState("");
  const [authUsername,setAuthUsername] = useState("");
  const [authCode,setAuthCode] = useState("");
  const [authStep,setAuthStep] = useState<"identity"|"code">("identity");
  const [authBusy,setAuthBusy] = useState(false);
  const [authError,setAuthError] = useState("");
  useEffect(() => {
    fetch("/api/me", { credentials:"same-origin" })
      .then(async response => response.ok ? (await response.json()).user as Account : null)
      .then(user => setAuthUser(user))
      .catch(() => setAuthUser(null))
      .finally(() => setAuthLoading(false));
  }, []);
  async function requestAuthCode() {
    setAuthBusy(true); setAuthError("");
    try {
      const response = await fetch("/api/auth/request-code", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({channel:authChannel,destination:authDestination})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось отправить код.");
      setAuthStep("code");
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Ошибка запроса."); }
    finally { setAuthBusy(false); }
  }
  async function verifyAuthCode() {
    setAuthBusy(true); setAuthError("");
    try {
      const response = await fetch("/api/auth/verify-code", {
        method:"POST", headers:{"Content-Type":"application/json"},
        credentials:"same-origin",
        body:JSON.stringify({channel:authChannel,destination:authDestination,code:authCode,username:authUsername})
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Неверный код.");
      setAuthUser(data.user as Account);
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Ошибка проверки кода."); }
    finally { setAuthBusy(false); }
  }
  async function logout() {
    await fetch("/api/auth/logout", {method:"POST",credentials:"same-origin"}).catch(()=>{});
    setAuthUser(null); setAuthStep("identity"); setAuthCode(""); setAuthUsername("");
  }
  const [chats,setChats] = useState<Chat[]>(initialChats);
  const [active,setActive] = useState("");
  const activeRef = useRef(active);
  const [query,setQuery] = useState("");
  const [draft,setDraft] = useState("");
  const [messages,setMessages] = useState<Message[]>(starterMessages);
  const [socket,setSocket] = useState<Socket|null>(null);
  const [chatLoading,setChatLoading] = useState(false);
  const [searchUser,setSearchUser] = useState("");
  const [searchResults,setSearchResults] = useState<{id:string;username:string;display_name:string|null}[]>([]);
  const [searchBusy,setSearchBusy] = useState(false);
  const [mobileChat,setMobileChat] = useState(false);
  const [showProfile,setShowProfile] = useState(false);
  const [showNewChat,setShowNewChat] = useState(false);
  const [showCreateGroup,setShowCreateGroup] = useState(false);
  const [groupTitle,setGroupTitle] = useState("");
  const [groupMembers,setGroupMembers] = useState("");
  const [groupBusy,setGroupBusy] = useState(false);
  const [chatFilter,setChatFilter] = useState<"all"|"direct"|"group">("all");
  const [notice,setNotice] = useState("");
  const current = chats.find(c=>c.id===active) ?? chats[0] ?? {id:"",name:"Выберите чат",handle:"",avatar:"I",color:"violet",message:"",time:"",unread:0};
  const filtered = useMemo(()=>chats.filter(c=>(chatFilter==="all"||c.type===chatFilter)&&(c.name+c.message+c.handle).toLowerCase().includes(query.toLowerCase())),[chats,query,chatFilter]);
  useEffect(()=>{activeRef.current=active;},[active]);
  async function loadChats() {
    const response = await fetch("/api/chats", {credentials:"same-origin"});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось загрузить чаты.");
    const mapped:Chat[] = data.chats.map((chat:any)=>({
      id:chat.id, type:chat.type==="group"?"group":"direct", name:chat.display_title || chat.title || "Группа",
      handle:chat.peer_username ? "@"+chat.peer_username : (chat.type==="group"?"группа":"личный чат"),
      avatar:(chat.display_title || chat.title || "I").slice(0,1).toUpperCase(), color:"violet",
      message:chat.last_message || "Нет сообщений",
      time:chat.last_message_at ? new Date(chat.last_message_at).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}) : "",
      unread:Number(chat.unread_count)||0, online:false
    }));
    setChats(mapped);
    if (!active && mapped.length) setActive(mapped[0].id);
    return mapped;
  }
  function mapMessage(raw:any):Message {
    return {id:raw.id,mine:raw.sender_id===authUser?.id,text:raw.body,time:new Date(raw.created_at).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}),sender:raw.sender_display_name||raw.sender_username||""};
  }
  useEffect(()=>{
    if (!authUser) return;
    let alive=true;
    loadChats().catch(error=>{if(alive)setNotice(error instanceof Error?error.message:"Ошибка загрузки чатов.");});
    const connection=io({withCredentials:true});
    connection.on("connect",()=>{if(alive)setSocket(connection);});
    connection.on("connect_error",()=>{if(alive)setNotice("Не удалось подключить синхронизацию чатов.");});
    connection.on("chat:message",(raw:any)=>{
      if(!alive)return;
      const message=mapMessage(raw);
      if(activeRef.current===raw.conversation_id)setMessages(prev=>prev.some(item=>item.id===message.id)?prev:[...prev,message]);
      setChats(prev=>prev.map(chat=>chat.id===raw.conversation_id?{...chat,message:raw.body,time:"Сейчас",unread:chat.id===activeRef.current?0:chat.unread+1}:chat));
    });
    return ()=>{alive=false;connection.disconnect();setSocket(null);};
  },[authUser?.id]);
  useEffect(()=>{
    if(!active)return;
    if(socket)socket.emit("chat:join",{conversationId:active});
    setChatLoading(true);setMessages([]);
    fetch("/api/chats/"+active+"/messages",{credentials:"same-origin"})
      .then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error||"Не удалось загрузить сообщения.");return data;})
      .then(data=>setMessages(prev=>{const history=data.messages.map(mapMessage);const historyIds=new Set(history.map(item=>item.id));return [...history,...prev.filter(item=>!historyIds.has(item.id))];}))
      .catch(error=>setNotice(error instanceof Error?error.message:"Ошибка загрузки сообщений."))
      .finally(()=>setChatLoading(false));
    return ()=>{if(socket)socket.emit("chat:leave",{conversationId:active});};
  },[active,socket]);
  async function sendMessage() {
    const value=draft.trim(); if(!value||!active)return;
    setDraft("");
    try {
      const response=await fetch("/api/chats/"+active+"/messages",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({body:value})});
      const data=await response.json(); if(!response.ok)throw new Error(data.error||"Не удалось отправить сообщение.");
      const message=mapMessage(data.message);
      setMessages(prev=>prev.some(item=>item.id===message.id)?prev:[...prev,message]);
      setChats(prev=>prev.map(c=>c.id===active?{...c,message:value,time:"Сейчас"}:c));
    } catch(error) {setDraft(value);setNotice(error instanceof Error?error.message:"Ошибка отправки.");}
  }
  function selectChat(chat:Chat) {setActive(chat.id);setMobileChat(true);setChats(prev=>prev.map(c=>c.id===chat.id?{...c,unread:0}:c));}
  async function searchPeople() {
    const value=searchUser.trim().replace(/^@/,"");if(!value)return;
    setSearchBusy(true);
    try {const response=await fetch("/api/users/search?username="+encodeURIComponent(value),{credentials:"same-origin"});const data=await response.json();if(!response.ok)throw new Error(data.error||"Поиск недоступен.");setSearchResults(data.users);}
    catch(error){setNotice(error instanceof Error?error.message:"Ошибка поиска.");} finally{setSearchBusy(false);}
  }
  async function openDirectChat(username:string) {
    try {const response=await fetch("/api/chats/direct",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({username})});const data=await response.json();if(!response.ok)throw new Error(data.error||"Не удалось создать чат.");await loadChats();setActive(data.conversationId);setShowNewChat(false);setSearchUser("");setSearchResults([]);setMobileChat(true);}
    catch(error){setNotice(error instanceof Error?error.message:"Ошибка создания чата.");}
  }
  async function createGroup() {
    const title=groupTitle.trim();
    const usernames=[...new Set(groupMembers.split(/[\\s,;]+/).map(value=>value.trim().replace(/^@/, "")).filter(Boolean))];
    if(title.length<2||!usernames.length){setNotice("Укажите название группы и хотя бы одного участника.");return;}
    setGroupBusy(true);
    try {
      const response=await fetch("/api/chats/group",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,usernames})});
      const data=await response.json();if(!response.ok)throw new Error(data.error||"Не удалось создать группу.");
      await loadChats();setActive(data.conversationId);setShowCreateGroup(false);setShowNewChat(false);setGroupTitle("");setGroupMembers("");setMobileChat(true);
    } catch(error){setNotice(error instanceof Error?error.message:"Ошибка создания группы.");}
    finally{setGroupBusy(false);}
  }
  if (authLoading) return <main className="auth-screen"><div className="auth-card"><span className="brand-mark">i</span><h1>IUFYE</h1><p>Подключаем аккаунт…</p></div></main>;
  if (!authUser) return <main className="auth-screen"><section className="auth-card">
    <div className="auth-brand"><span className="brand-mark">i</span><span>IUFYE</span></div>
    <h1>{authStep==="identity"?"Добро пожаловать":"Проверьте код"}</h1>
    <p>{authStep==="identity"?"Войдите или создайте аккаунт. Мы отправим одноразовый код.":"Введите шестизначный код из сообщения."}</p>
    {authStep==="identity" ? <>
      <div className="auth-switch"><button className={authChannel==="email"?"active":""} onClick={()=>setAuthChannel("email")}>Почта</button><button className={authChannel==="phone"?"active":""} onClick={()=>setAuthChannel("phone")}>Телефон</button></div>
      <label>{authChannel==="email"?"Адрес электронной почты":"Телефон в международном формате"}</label>
      <input className="auth-input" value={authDestination} onChange={e=>setAuthDestination(e.target.value)} placeholder={authChannel==="email"?"name@example.com":"+31612345678"} autoComplete={authChannel==="email"?"email":"tel"}/>
      <label>Username</label><input className="auth-input" value={authUsername} onChange={e=>setAuthUsername(e.target.value)} placeholder="например, iufye_user" autoComplete="username"/>
      <small className="auth-hint">4–32 символа: латинские буквы, цифры и _</small>
      <button className="auth-primary" disabled={authBusy||!authDestination.trim()||!authUsername.trim()} onClick={requestAuthCode}>{authBusy?"Отправляем…":"Получить код"}</button>
    </> : <>
      <label>Код подтверждения</label><input className="auth-input code-input" value={authCode} onChange={e=>setAuthCode(e.target.value.replace(/\D/g,"").slice(0,6))} placeholder="000000" inputMode="numeric" autoComplete="one-time-code"/>
      <button className="auth-primary" disabled={authBusy||authCode.length!==6} onClick={verifyAuthCode}>{authBusy?"Проверяем…":"Подтвердить и войти"}</button>
      <button className="auth-back" onClick={()=>{setAuthStep("identity");setAuthCode("");setAuthError("");}}>Изменить адрес или номер</button>
    </>}
    {authError&&<div className="auth-error">{authError}</div>}
    <div className="auth-foot">Продолжая, вы подтверждаете, что имеете право использовать этот адрес или номер.</div>
  </section></main>;

  return <main className="app-shell">
    <aside className={`sidebar ${mobileChat?"mobile-hidden":""}`}>
      <div className="side-top">
        <button className="icon-button" aria-label="Меню" onClick={()=>setShowProfile(!showProfile)}><MoreHorizontal size={21}/></button>
        <div className="brand"><span className="brand-mark">i</span><span>IUFYE</span></div>
        <button className="icon-button" aria-label="Новый чат" onClick={()=>setShowNewChat(true)}><Pencil size={18}/></button>
      </div>
      <div className="search-wrap"><Search size={17}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Поиск"/><kbd>⌘ K</kbd></div>
      <div className="filter-row"><button className={`filter ${chatFilter==="all"?"active":""}`} onClick={()=>setChatFilter("all")}>Все чаты</button><button className={`filter ${chatFilter==="direct"?"active":""}`} onClick={()=>setChatFilter("direct")}>Личные</button><button className={`filter ${chatFilter==="group"?"active":""}`} onClick={()=>setChatFilter("group")}>Группы</button></div>
      <div className="chat-list">{filtered.map(chat=><button key={chat.id} className={`chat-item ${active===chat.id?"selected":""}`} onClick={()=>selectChat(chat)}>
        <span className={`avatar ${chat.color}`}>{chat.avatar}{chat.online&&<i className="online-dot"/>}</span>
        <span className="chat-copy"><span className="chat-line"><strong>{chat.name}</strong><time>{chat.time}</time></span><span className="chat-line preview"><span>{chat.message}</span>{chat.unread>0&&<b className="unread">{chat.unread}</b>}</span></span>
      </button>)}{filtered.length===0&&<div className="empty-search">Ничего не найдено</div>}</div>
      <div className="sidebar-bottom">
        <button onClick={()=>setNotice("Раздел контактов скоро появится")}><Users size={18}/><span>Контакты</span></button>
        <button onClick={()=>setNotice("Настройки скоро появятся")}><Settings size={18}/><span>Настройки</span></button>
        <button onClick={()=>setNotice("Избранное находится в списке чатов")}><Bookmark size={18}/><span>Избранное</span></button>
        <div className="user-mini" onClick={()=>setShowProfile(true)}><span className="avatar small violet">D</span><span><b>{authUser.display_name || authUser.username}</b><small>@{authUser.username}</small></span><MoreHorizontal size={18}/></div>
      </div>
    </aside>
    <section className={`conversation ${mobileChat?"mobile-visible":""}`}>
      <header className="conversation-header">
        <button className="icon-button back-button" onClick={()=>setMobileChat(false)} aria-label="Назад"><ChevronLeft/></button>
        {active&&<span className={`avatar header-avatar ${current.color}`}>{current.avatar}</span>}
        <button className="person-heading" onClick={()=>active&&setShowProfile(true)}><strong>{current.name}</strong><small>{current.online?"в сети":current.handle}</small></button>
        <div className="header-actions">
          <button className="icon-button" aria-label="Аудиозвонок" onClick={()=>setNotice("Звонки появятся в следующем обновлении")}><Phone size={19}/></button>
          <button className="icon-button" aria-label="Видеозвонок" onClick={()=>setNotice("Видеозвонки появятся в следующем обновлении")}><Video size={20}/></button>
          <button className="icon-button" aria-label="Информация" onClick={()=>setShowProfile(true)}><Info size={19}/></button>
        </div>
      </header>
      <div className="message-area">{active&&<div className="date-pill">История сообщений</div>}{chatLoading&&<div className="empty-search">Загружаем сообщения…</div>}{!active&&!chatLoading&&<div className="empty-search">Выберите чат или начните новый</div>}
        {messages.map(m=><div key={m.id} className={`message-row ${m.mine?"mine":""}`}><div className="bubble">{!m.mine&&m.sender&&<small className="message-sender">{m.sender}</small>}{m.text}<span className="message-meta">{m.time}{m.mine&&<CheckCheck size={14}/>}</span></div></div>)}
        {active&&<div className="encryption-note">Сообщения сохраняются в аккаунте и синхронизируются между подключёнными устройствами.</div>}
      </div>
      <div className="composer">
        <button className="icon-button" aria-label="Прикрепить файл" onClick={()=>setNotice("Загрузка файлов будет подключена следующим этапом")}><Paperclip size={21}/></button>
        <input value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendMessage()} placeholder={active?"Сообщение...":"Сначала выберите чат"} disabled={!active}/>
        <button className="icon-button" aria-label="Эмодзи" onClick={()=>setDraft(v=>v+"🙂")}><Smile size={21}/></button>
        {draft.trim()&&active?<button className="send-button" onClick={sendMessage} aria-label="Отправить"><Send size={18}/></button>:<button className="icon-button" aria-label="Голосовое сообщение" onClick={()=>setNotice("Голосовые сообщения появятся позже")}><Mic size={21}/></button>}
      </div>
    </section>
    {showProfile&&<div className="overlay" onClick={()=>setShowProfile(false)}><section className="profile-panel" onClick={e=>e.stopPropagation()}>
      <button className="close-button" onClick={()=>setShowProfile(false)}><X/></button><span className={`avatar profile-avatar ${current.color}`}>{current.avatar}</span><h2>{current.name}</h2><p>{current.handle}</p>
      <div className="profile-actions"><button onClick={()=>setNotice("Уведомления скоро появятся")}><Bell/>Уведомления</button><button onClick={()=>setNotice("Медиафайлы скоро появятся")}><ImageIcon/>Медиафайлы</button><button onClick={()=>setNotice("Файлы скоро появятся")}><FileText/>Файлы</button><button onClick={()=>setNotice("Архив скоро появится")}><Archive/>Архив</button></div><button className="logout-button" onClick={logout}>Выйти из аккаунта</button>
    </section></div>}
    {showNewChat&&<div className="overlay" onClick={()=>setShowNewChat(false)}><section className="new-chat-panel" onClick={e=>e.stopPropagation()}>
      <button className="close-button" onClick={()=>setShowNewChat(false)}><X/></button><h2>Новое сообщение</h2><p>Найди человека по его уникальному username.</p><button className="create-group-link" onClick={()=>{setShowNewChat(false);setShowCreateGroup(true);}}>＋ Создать группу</button><div className="search-wrap"><Search size={17}/><input value={searchUser} onChange={e=>setSearchUser(e.target.value)} onKeyDown={e=>e.key==="Enter"&&searchPeople()} placeholder="@username"/><button className="search-action" onClick={searchPeople} disabled={searchBusy}>{searchBusy?"…":"Найти"}</button></div><div className="user-search-results">{searchResults.map(person=><button key={person.id} onClick={()=>openDirectChat(person.username)}><span className="avatar small violet">{(person.display_name||person.username).slice(0,1).toUpperCase()}</span><span><b>{person.display_name||person.username}</b><small>@{person.username}</small></span></button>)}</div>
    </section></div>}
    {showCreateGroup&&<div className="overlay" onClick={()=>setShowCreateGroup(false)}><section className="new-chat-panel" onClick={e=>e.stopPropagation()}>
      <button className="close-button" onClick={()=>setShowCreateGroup(false)}><X/></button><h2>Новая группа</h2><p>Создай общий чат и добавь участников по их username.</p>
      <label className="group-label">Название группы</label><input className="group-input" value={groupTitle} onChange={e=>setGroupTitle(e.target.value)} maxLength={80} placeholder="Например, Команда"/>
      <label className="group-label">Участники</label><textarea className="group-input group-members" value={groupMembers} onChange={e=>setGroupMembers(e.target.value)} placeholder="@username1, @username2"/><small className="group-hint">Укажи от 1 до 49 username через запятую или пробел. Ты автоматически станешь владельцем группы.</small>
      <button className="auth-primary" disabled={groupBusy||groupTitle.trim().length<2||!groupMembers.trim()} onClick={createGroup}>{groupBusy?"Создаём…":"Создать группу"}</button>
    </section></div>}
    {notice&&<div className="toast" onClick={()=>setNotice("")}>{notice}<button><X size={15}/></button></div>}
  </main>;
}