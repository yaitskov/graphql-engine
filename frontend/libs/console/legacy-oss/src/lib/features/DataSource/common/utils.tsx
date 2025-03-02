import { FaFolder, FaTable } from 'react-icons/fa';
import React from 'react';
import { Table } from '@/features/MetadataAPI';
import { IntrospectedTable, TableColumn } from '../types';
import { RunSQLResponse } from '../api';

export const adaptIntrospectedTables = (
  runSqlResponse: RunSQLResponse
): IntrospectedTable[] => {
  /* 
    The `slice(1)` on the result is done because the first item of the result is always the columns names from the SQL output.
    It is not required for the final result and should be avoided 
  */
  const adaptedResponse = runSqlResponse?.result
    ?.slice(1)
    .map((row: string[]) => ({
      name: `${row[1]}.${row[0]}`,
      table: {
        name: row[0],
        schema: row[1],
      },
      type: row[2],
    }));

  return adaptedResponse ?? [];
};

export const adaptTableColumns = (
  result: RunSQLResponse['result']
): TableColumn[] => {
  if (!result) return [];

  return result.slice(1).map(row => ({
    name: row[0],
    dataType: row[1],
  }));
};

export const convertToTreeData = (
  tables: Table[],
  hierarchy: string[],
  name: string
): any => {
  if (!hierarchy.length) return;

  const key = hierarchy[0];

  function onlyUnique(value: any, index: any, self: string | any[]) {
    return self.indexOf(value) === index;
  }

  const levelValues: string[] = tables.map((t: any) => t[key]).filter(Boolean);

  const uniqueLevelValues = levelValues.filter(onlyUnique);

  return [
    ...uniqueLevelValues.map(levelValue => {
      // eslint-disable-next-line no-underscore-dangle
      const _key = JSON.stringify({ ...JSON.parse(name), [key]: levelValue });
      const children = convertToTreeData(
        tables.filter((t: any) => t[key] === levelValue),
        hierarchy.slice(1),
        _key
      );

      if (!children)
        return {
          icon: <FaTable />,
          title: levelValue,
          key: _key,
        };

      return {
        icon: <FaFolder />,
        title: levelValue,
        selectable: false,
        children,
        key: _key,
      };
    }),
  ];
};
