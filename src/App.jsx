import Home from './components/Home.jsx';
import Board from './components/Board.jsx';
import MacBrowserHost, { isMacBrowserHostMode } from './components/MacBrowserHost.jsx';

function parseRoute() {
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
  const pathname = basePath && window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length)
    : window.location.pathname;

  const match = pathname.match(/^\/board\/([A-Za-z0-9_-]+)$/);
  if (!match) return { name: 'home' };
  return { name: 'board', boardId: match[1] };
}

export default function App() {
  if (isMacBrowserHostMode() && new URLSearchParams(window.location.search).get('alexMacAccountHost') === '1') {
    return <MacBrowserHost accountMode />;
  }
  const route = parseRoute();
  if (route.name === 'board') {
    return <Board boardId={route.boardId} />;
  }
  return <Home />;
}
