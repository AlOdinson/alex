import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceRequired(path, from, to) {
  let source = read(path);
  if (source.includes(to)) return false;
  if (!source.includes(from)) {
    throw new Error(`Localization migration anchor not found in ${path}: ${from.slice(0, 100)}`);
  }
  source = source.replace(from, to);
  write(path, source);
  return true;
}

function appendOnce(path, marker, content) {
  const source = read(path);
  if (source.includes(marker)) return false;
  write(path, `${source.trimEnd()}\n\n${content.trim()}\n`);
  return true;
}

const changed = [];
function patch(path, from, to) {
  if (replaceRequired(path, from, to)) changed.push(path);
}

// Home: teacher language selector + role-persistent language context.
patch(
  'src/components/Home.jsx',
  "import TeacherAccountPanel from './TeacherAccountPanel.jsx';",
  "import TeacherAccountPanel from './TeacherAccountPanel.jsx';\nimport LanguageToggle from './LanguageToggle.jsx';\nimport { useLanguage } from './LanguageProvider.jsx';",
);
patch(
  'src/components/Home.jsx',
  "export default function Home() {\n  const [title, setTitle] = useState('Новая доска');",
  "export default function Home() {\n  const { language, t, formatDate } = useLanguage();\n  const [title, setTitle] = useState(() => t('home.newBoard'));",
);
patch(
  'src/components/Home.jsx',
  "  const autoPruneAttemptedRef = useRef(new Set());\n\n  const refreshBoards = useCallback(async () => {",
  "  const autoPruneAttemptedRef = useRef(new Set());\n  const previousDefaultBoardTitleRef = useRef(t('home.newBoard'));\n\n  useEffect(() => {\n    const nextDefault = t('home.newBoard');\n    const previousDefault = previousDefaultBoardTitleRef.current;\n    setTitle((current) => (current === previousDefault ? nextDefault : current));\n    previousDefaultBoardTitleRef.current = nextDefault;\n  }, [language, t]);\n\n  const refreshBoards = useCallback(async () => {",
);
patch(
  'src/components/Home.jsx',
  "      <section className=\"home-card create-board-card\">\n        <div className=\"brand-mark\">A</div>",
  "      <section className=\"home-card create-board-card\">\n        <div className=\"home-language-row\"><LanguageToggle /></div>\n        <div className=\"brand-mark\">A</div>",
);
patch(
  'src/components/Home.jsx',
  "    const nextTitle = window.prompt('Новое название доски', board.title ?? 'Новая доска');",
  "    const nextTitle = window.prompt('Новое название доски', board.title ?? t('home.newBoard'));",
);
patch(
  'src/components/Home.jsx',
  "                <h3>{board.title || 'Новая доска'}</h3>\n                <p className=\"board-student\">{board.studentName || 'Ученик не указан'}</p>",
  "                <h3 data-i18n-skip>{board.title || t('home.newBoard')}</h3>\n                <p className=\"board-student\">{board.studentName ? <span data-i18n-skip>{board.studentName}</span> : 'Ученик не указан'}</p>",
);

// Toolbar: always-visible compact RU/EN selector inside a board.
patch(
  'src/components/Toolbar.jsx',
  "import DrawingPresets from './DrawingPresets.jsx';",
  "import DrawingPresets from './DrawingPresets.jsx';\nimport LanguageToggle from './LanguageToggle.jsx';",
);
patch(
  'src/components/Toolbar.jsx',
  "        <div className={`toolbar-status sync-${syncTone}`} title={saveStatus}>",
  "        <LanguageToggle compact />\n\n        <div className={`toolbar-status sync-${syncTone}`} title={saveStatus}>",
);

// Board: choose language by actual permission and expose selector before name entry.
patch(
  'src/components/Board.jsx',
  "import Toolbar from './Toolbar.jsx';",
  "import Toolbar from './Toolbar.jsx';\nimport LanguageToggle from './LanguageToggle.jsx';\nimport { LanguageProvider, useLanguage } from './LanguageProvider.jsx';",
);
patch(
  'src/components/Board.jsx',
  "function NameGate({ title, onSubmit }) {\n  const [name, setName] = useState('');",
  "function NameGate({ title, titleIsUserContent = false, onSubmit }) {\n  const [name, setName] = useState('');",
);
patch(
  'src/components/Board.jsx',
  "      <section className=\"gate-card\">\n        <div className=\"brand-mark\">A</div>\n        <h1>{title}</h1>\n        <p>Введите имя, которое увидит преподаватель.</p>",
  "      <section className=\"gate-card\">\n        <div className=\"gate-language-row\"><LanguageToggle /></div>\n        <div className=\"brand-mark\">A</div>\n        <h1 data-i18n-skip={titleIsUserContent ? '' : undefined}>{title}</h1>\n        <p>Введите имя, которое увидит преподаватель.</p>",
);
patch(
  'src/components/Board.jsx',
  "  if (loading) {\n    return <AccessMessage title=\"Открываю доску\">Загружаю сохранённое состояние…</AccessMessage>;\n  }\n  if (error) {\n    return <AccessMessage title=\"Ошибка доступа\">{error}</AccessMessage>;\n  }\n  if (!access) {\n    return <AccessMessage title=\"Доска не найдена\">Ссылка неверна или доступ был отозван.</AccessMessage>;\n  }\n  if (access.permission === 'closed') {\n    return <AccessMessage title=\"Доска закрыта\">Преподаватель временно закрыл гостевой доступ.</AccessMessage>;\n  }",
  "  const pendingRole = rememberedOwnerKey ? 'teacher' : 'student';\n  if (loading) {\n    return <LanguageProvider role={pendingRole}><AccessMessage title=\"Открываю доску\">Загружаю сохранённое состояние…</AccessMessage></LanguageProvider>;\n  }\n  if (error) {\n    return <LanguageProvider role={pendingRole}><AccessMessage title=\"Ошибка доступа\">{error}</AccessMessage></LanguageProvider>;\n  }\n  if (!access) {\n    return <LanguageProvider role={pendingRole}><AccessMessage title=\"Доска не найдена\">Ссылка неверна или доступ был отозван.</AccessMessage></LanguageProvider>;\n  }\n  if (access.permission === 'closed') {\n    return <LanguageProvider role={pendingRole}><AccessMessage title=\"Доска закрыта\">Преподаватель временно закрыл гостевой доступ.</AccessMessage></LanguageProvider>;\n  }",
);
patch(
  'src/components/Board.jsx',
  "  if (!resolvedName) {\n    return (\n      <NameGate\n        title={isOwner ? 'Как показывать ваше имя на доске?' : access.title}\n        onSubmit={(name) => {\n          if (isOwner) localStorage.setItem('alex-board:owner-name', name);\n          else sessionStorage.setItem(`alex-board:name:${boardId}`, name);\n          setGuestName(name);\n        }}\n      />\n    );\n  }",
  "  if (!resolvedName) {\n    return (\n      <LanguageProvider role={isOwner ? 'teacher' : 'student'}>\n        <NameGate\n          title={isOwner ? 'Как показывать ваше имя на доске?' : access.title}\n          titleIsUserContent={!isOwner}\n          onSubmit={(name) => {\n            if (isOwner) localStorage.setItem('alex-board:owner-name', name);\n            else sessionStorage.setItem(`alex-board:name:${boardId}`, name);\n            setGuestName(name);\n          }}\n        />\n      </LanguageProvider>\n    );\n  }",
);
patch(
  'src/components/Board.jsx',
  "  if (isMacBrowserHostMode()) {\n    return (\n      <MacBrowserHost\n        boardId={boardId}\n        boardKey={boardKey}\n        realtimeKey={access.realtimeKey}\n        participantName={resolvedName}\n        permission={access.permission}\n      />\n    );\n  }",
  "  if (isMacBrowserHostMode()) {\n    return (\n      <LanguageProvider role={isOwner ? 'teacher' : 'student'}>\n        <MacBrowserHost\n          boardId={boardId}\n          boardKey={boardKey}\n          realtimeKey={access.realtimeKey}\n          participantName={resolvedName}\n          permission={access.permission}\n        />\n      </LanguageProvider>\n    );\n  }",
);
patch(
  'src/components/Board.jsx',
  "  if (workspaceMode === 'games') {\n    return (\n      <GameLibrary\n        boardId={boardId}\n        boardKey={boardKey}\n        realtimeKey={access.realtimeKey}\n        boardTitle={access.title}\n        participantName={resolvedName}\n        participantClientId={participantClientIdRef.current}\n        permission={access.permission}\n        onExit={returnToBoard}\n      />\n    );\n  }",
  "  if (workspaceMode === 'games') {\n    return (\n      <LanguageProvider role={isOwner ? 'teacher' : 'student'}>\n        <GameLibrary\n          boardId={boardId}\n          boardKey={boardKey}\n          realtimeKey={access.realtimeKey}\n          boardTitle={access.title}\n          participantName={resolvedName}\n          participantClientId={participantClientIdRef.current}\n          permission={access.permission}\n          onExit={returnToBoard}\n        />\n      </LanguageProvider>\n    );\n  }",
);
patch(
  'src/components/Board.jsx',
  "  return (\n    <BoardWorkspace\n      boardId={boardId}\n      boardKey={boardKey}\n      initialAccess={access}\n      participantName={resolvedName}\n      participantClientId={participantClientIdRef.current}\n      onAccessChange={setAccess}\n      onOpenGameLibrary={() => setWorkspaceMode('games')}\n    />\n  );\n}",
  "  return (\n    <LanguageProvider role={isOwner ? 'teacher' : 'student'}>\n      <BoardWorkspace\n        boardId={boardId}\n        boardKey={boardKey}\n        initialAccess={access}\n        participantName={resolvedName}\n        participantClientId={participantClientIdRef.current}\n        onAccessChange={setAccess}\n        onOpenGameLibrary={() => setWorkspaceMode('games')}\n      />\n    </LanguageProvider>\n  );\n}",
);
patch(
  'src/components/Board.jsx',
  "}) {\n  const canvasElementRef = useRef(null);\n  const canvasHostRef = useRef(null);",
  "}) {\n  const { ui } = useLanguage();\n  const canvasElementRef = useRef(null);\n  const canvasHostRef = useRef(null);",
);
patch(
  'src/components/Board.jsx',
  "              <span className=\"remote-cursor-name\">{cursor.name || 'Участник'}</span>",
  "              <span className=\"remote-cursor-name\" data-i18n-skip>{cursor.name || ui('Участник')}</span>",
);
patch(
  'src/components/Board.jsx',
  "              Редактирует {lock.name || 'участник'}",
  "              {ui('Редактирует')} <span data-i18n-skip>{lock.name || ui('участник')}</span>",
);

if (appendOnce('src/styles.css', '/* RU/EN language switcher */', `
/* RU/EN language switcher */
.language-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border: 1px solid rgba(148, 163, 184, 0.45);
  border-radius: 999px;
  background: rgba(248, 250, 252, 0.92);
  white-space: nowrap;
}

.language-toggle button {
  border: 0;
  border-radius: 999px;
  padding: 6px 10px;
  background: transparent;
  color: #475569;
  font: inherit;
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  cursor: pointer;
}

.language-toggle button.active {
  background: #111827;
  color: #fff;
}

.language-toggle-compact {
  flex: 0 0 auto;
}

.language-toggle-compact button {
  padding: 5px 7px;
  font-size: 11px;
}

.home-language-row,
.gate-language-row {
  display: flex;
  justify-content: flex-end;
  width: 100%;
  margin-bottom: 4px;
}
`)) changed.push('src/styles.css');

console.log(`Localization integration applied: ${[...new Set(changed)].join(', ') || 'already up to date'}`);
