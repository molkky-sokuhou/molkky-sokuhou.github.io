// 独立したテスト用プロジェクトで一度だけ手動実行します。
function setupTest() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TEST_SHEET')) {
    const book = SpreadsheetApp.create('月いちモルック 受付通信テスト');
    book.getSheets()[0].getRange('A1:B1').setValues([['名簿番号','受付時刻']]);
    props.setProperties({TEST_SHEET:book.getId(), TEST_PASS:Utilities.getUuid().slice(0,8)});
  }
  console.log('テスト用運営コード ' + props.getProperty('TEST_PASS'));
}
function doPost(e) {
  const result = value => ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
  const props = PropertiesService.getScriptProperties();
  const pass = props.getProperty('TEST_PASS');
  const data = JSON.parse(e.postData.contents);
  if (!pass || data.pass !== pass) return result({error:'テスト用運営コードを確認してください。'});
  if (!Array.isArray(data.ids) || data.ids.length > 24 || data.ids.some(i => !Number.isInteger(i) || i<1 || i>24)) return result({error:'名簿番号を確認してください。'});
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sheet = SpreadsheetApp.openById(props.getProperty('TEST_SHEET')).getSheets()[0];
    const count = sheet.getLastRow()-1;
    const accepted = new Set(count ? sheet.getRange(2,1,count,1).getValues().flat() : []);
    const added = [...new Set(data.ids)].filter(i => !accepted.has(i));
    if (added.length) {
      sheet.getRange(count+2,1,added.length,2).setValues(added.map(i=>[i,new Date()]));
      SpreadsheetApp.flush();
      added.forEach(i=>accepted.add(i));
    }
    return result({ids:[...accepted]});
  } finally { lock.releaseLock(); }
}
