import type { ReactNode } from 'react';

export interface TabsItem<T extends string> {
  key: T;
  label: ReactNode;
  hidden?: boolean;
}

interface TabsProps<T extends string> {
  items: TabsItem<T>[];
  active: T;
  onChange: (key: T) => void;
  tabType?: 'default' | 'button';
  ariaLabel?: string;
}

const Tabs = <T extends string>({
  items,
  active,
  onChange,
  tabType = 'default',
  ariaLabel = 'Tabs',
}: TabsProps<T>) => {
  const visible = items.filter((item) => !item.hidden);

  const linkClasses =
    tabType === 'button'
      ? 'px-3 py-2 text-sm font-medium transition duration-300 rounded-md whitespace-nowrap mx-2 my-1'
      : 'px-1 py-4 ml-8 text-sm font-medium leading-5 transition duration-300 border-b-2 border-transparent whitespace-nowrap first:ml-0';
  const activeColor =
    tabType === 'button'
      ? 'bg-indigo-700'
      : 'text-indigo-500 border-indigo-600';
  const inactiveColor =
    tabType === 'button'
      ? 'bg-gray-800 hover:bg-gray-700 focus:bg-gray-700'
      : 'text-gray-500 border-transparent hover:text-gray-300 hover:border-gray-400 focus:text-gray-300 focus:border-gray-400';

  return (
    <>
      <div className="sm:hidden">
        <label htmlFor="tabs" className="sr-only">
          Select a Tab
        </label>
        <select
          id="tabs"
          value={active}
          onChange={(e) => onChange(e.target.value as T)}
          aria-label="Selected Tab"
        >
          {visible.map((item) => (
            <option key={item.key} value={item.key}>
              {typeof item.label === 'string' ? item.label : item.key}
            </option>
          ))}
        </select>
      </div>
      {tabType === 'button' ? (
        <div className="hidden sm:block">
          <nav className="-mx-2 -my-1 flex flex-wrap" aria-label={ariaLabel}>
            {visible.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onChange(item.key)}
                className={`${linkClasses} ${
                  item.key === active ? activeColor : inactiveColor
                }`}
                aria-current={item.key === active ? 'page' : undefined}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      ) : (
        <div className="hide-scrollbar hidden overflow-x-scroll border-b border-gray-600 sm:block">
          <nav className="flex" aria-label={ariaLabel}>
            {visible.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => onChange(item.key)}
                className={`${linkClasses} ${
                  item.key === active ? activeColor : inactiveColor
                }`}
                aria-current={item.key === active ? 'page' : undefined}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      )}
    </>
  );
};

export default Tabs;
