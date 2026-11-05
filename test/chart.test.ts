import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { test } from 'node:test';

test('Highcharts React export được nhận diện là component render được', () => {
  const markup = renderToString(React.createElement(HighchartsReact, { highcharts: Highcharts, options: { series: [] } }));
  assert.equal(markup, '<div></div>');
});
