import { SearchField } from '@heroui/react'

interface ExportSearchBarProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  'aria-label': string
}

export default function ExportSearchBar({ value, onChange, placeholder, 'aria-label': ariaLabel }: ExportSearchBarProps) {
  return (
    <SearchField aria-label={ariaLabel} value={value} onChange={onChange}>
      <SearchField.Group>
        <SearchField.SearchIcon />
        <SearchField.Input placeholder={placeholder} />
        <SearchField.ClearButton />
      </SearchField.Group>
    </SearchField>
  )
}
