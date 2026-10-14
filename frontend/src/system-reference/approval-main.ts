import { mountReferenceApprovalPage } from './approval-page';
import { installProductTheme } from '../theme';
import '../theme.css';
import './reference.css';

const host = document.getElementById('reference-approval-root');
if (host) {
  const disposeTheme = installProductTheme(document);
  const page = mountReferenceApprovalPage(host, { search: window.location.search, hash: window.location.hash });
  window.addEventListener('pagehide', () => { page.dispose(); disposeTheme(); }, { once: true });
}
