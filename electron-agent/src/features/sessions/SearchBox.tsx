import { SearchBar } from '@lobehub/ui';
import { useSessionStore } from '../../store/session';

export function SearchBox() {
  const keyword = useSessionStore((s) => s.searchKeyword);
  const setKeyword = useSessionStore((s) => s.setSearchKeyword);
  return (
    <SearchBar
      enableShortKey
      shortKey="mod+f"
      size="small"
      variant="filled"
      placeholder="搜索会话 / 项目"
      value={keyword}
      onChange={(e) => setKeyword(e.target.value)}
      style={{ width: '100%' }}
    />
  );
}
