#!/usr/bin/env python3
"""
MT Baccarat DOM 抓取器
Selenium 登入娛樂城 → 進入 MT 遊戲大廳 → 定期讀取 DOM 牌桌資料 → POST 給 Node.js server

抓取資料：牌桌編號、荷官名字、莊閒和統計、牌路歷史
"""

import os
import sys
import json
import time
import re
import requests
from dotenv import load_dotenv
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    NoSuchElementException, TimeoutException, 
    StaleElementReferenceException, WebDriverException
)

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

# ===== 設定 =====
CASINO_URL = os.getenv('MT_CASINO_URL', 'https://seofufan.seogrwin1688.com/')
CASINO_USER = os.getenv('MT_CASINO_USERNAME', '')
CASINO_PASS = os.getenv('MT_CASINO_PASSWORD', '')
NODE_SERVER = os.getenv('NODE_SERVER_URL', 'http://localhost:3000')
CHROME_PATH = os.getenv('CHROME_PATH', '')
POLL_INTERVAL = int(os.getenv('POLL_INTERVAL', '8'))  # 秒


# ===== DOM 資料讀取 =====
SCRAPE_TABLES_JS = """
(function() {
    var result = [];
    
    // MT 遊戲大廳：每張牌桌是一個卡片區塊
    // 從截圖觀察，每張桌有：百家樂 N、人數、莊N 閒N 和N、荷官名字
    // 嘗試多種 DOM 選擇器
    
    // 策略1：找所有包含「百家樂」+「莊」+「閒」的區塊
    var allElements = document.querySelectorAll('*');
    var processed = new Set();
    
    for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        if (processed.has(el)) continue;
        
        var text = el.innerText || '';
        if (text.length < 10 || text.length > 500) continue;
        
        // 必須同時包含「百家樂」和「莊」和「閒」
        if (!text.includes('百家樂')) continue;
        if (!text.includes('莊')) continue;
        if (!text.includes('閒')) continue;
        
        // 避免重複（父子元素都匹配）
        var dominated = false;
        for (var j = 0; j < result.length; j++) {
            if (result[j]._el && (result[j]._el.contains(el) || el.contains(result[j]._el))) {
                // 保留較小的（更精確的）
                if (el.innerText.length < result[j].rawText.length) {
                    result[j] = null;  // 標記移除
                } else {
                    dominated = true;
                }
                break;
            }
        }
        if (dominated) continue;
        
        // 提取桌號：「百家樂 N」或「百家樂 B01」
        var tableMatch = text.match(/百家樂\\s*(\\S+)/);
        var tableNum = tableMatch ? tableMatch[1] : '?';
        
        // 提取統計：「莊N 閒N 和N」
        var statsMatch = text.match(/莊\\s*(\\d+)\\s*(?:.*?)閒\\s*(\\d+)\\s*(?:.*?)和\\s*(\\d+)/);
        var banker = statsMatch ? parseInt(statsMatch[1]) : 0;
        var player = statsMatch ? parseInt(statsMatch[2]) : 0;
        var tie = statsMatch ? parseInt(statsMatch[3]) : 0;
        
        // 提取荷官名字（中文或英文名，通常在卡片底部）
        // 常見格式：「中文 田田」「RANG RANG」「PEI YING」
        var dealerName = '';
        var dealerPatterns = [
            /中文\\s+([\\u4e00-\\u9fff]+)/,           // 中文 田田
            /([A-Z][A-Z ]{2,20})(?:\\s|$)/,            // RANG RANG
            /(?:^|\\n)\\s*([\\u4e00-\\u9fff]{2,4})\\s*$/m  // 最後一行中文名
        ];
        for (var k = 0; k < dealerPatterns.length; k++) {
            var dm = text.match(dealerPatterns[k]);
            if (dm) {
                dealerName = dm[1].trim();
                break;
            }
        }
        
        // 提取人數
        var playersMatch = text.match(/(\\d+)\\s*人?/);
        var onlinePlayers = playersMatch ? parseInt(playersMatch[1]) : 0;
        
        // 提取牌路文字（莊莊閒閒和...序列）
        var roadText = '';
        var roadMatch = text.match(/([莊閒和]{4,})/g);
        if (roadMatch) {
            roadText = roadMatch.join('');
        }
        
        result.push({
            tableNum: tableNum,
            banker: banker,
            player: player,
            tie: tie,
            total: banker + player + tie,
            dealer: dealerName,
            onlinePlayers: onlinePlayers,
            roadText: roadText.substring(0, 60),
            rawText: text.substring(0, 200),
            _el: el
        });
        
        // 標記已處理
        processed.add(el);
    }
    
    // 清理 null 和 _el
    result = result.filter(function(r) { return r !== null; });
    result.forEach(function(r) { delete r._el; });
    
    // 去重：同桌號只保留一個
    var seen = {};
    var unique = [];
    for (var m = 0; m < result.length; m++) {
        var key = result[m].tableNum + '_' + result[m].banker + '_' + result[m].player;
        if (!seen[key]) {
            seen[key] = true;
            unique.push(result[m]);
        }
    }
    
    return unique;
})();
"""


# ===== 主程式 =====
def create_driver():
    """建立 Chrome driver"""
    chrome_options = Options()
    chrome_options.add_argument('--no-sandbox')
    chrome_options.add_argument('--disable-dev-shm-usage')
    chrome_options.add_argument('--disable-gpu')
    chrome_options.add_argument('--window-size=1400,900')
    chrome_options.add_argument('--disable-blink-features=AutomationControlled')
    chrome_options.add_experimental_option('excludeSwitches', ['enable-automation'])
    chrome_options.add_experimental_option('useAutomationExtension', False)

    if sys.platform == 'linux' and not os.environ.get('DISPLAY'):
        chrome_options.add_argument('--headless=new')

    if CHROME_PATH:
        chrome_options.binary_location = CHROME_PATH

    driver = webdriver.Chrome(options=chrome_options)

    driver.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument', {
        'source': '''
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            delete navigator.__proto__.webdriver;
        '''
    })
    return driver


def find_inputs_in_all_frames(driver):
    """在主頁面和所有 iframe/shadow DOM 中搜尋 input 欄位"""
    # 1. 主頁面
    inputs = driver.find_elements(By.TAG_NAME, 'input')
    visible = [i for i in inputs if i.is_displayed()]
    if visible:
        return visible, False

    # 2. 所有 iframe（遞迴）
    iframes = driver.find_elements(By.TAG_NAME, 'iframe')
    print(f"🔍 找到 {len(iframes)} 個 iframe")
    for idx, iframe in enumerate(iframes):
        try:
            src = iframe.get_attribute('src') or ''
            print(f"🔍 iframe[{idx}]: {src[:80]}")
            driver.switch_to.frame(iframe)
            inputs = driver.find_elements(By.TAG_NAME, 'input')
            visible = [i for i in inputs if i.is_displayed()]
            if visible:
                print(f"✅ iframe[{idx}] 有 {len(visible)} 個可見 input")
                return visible, True
            # 可能有嵌套 iframe
            sub_iframes = driver.find_elements(By.TAG_NAME, 'iframe')
            for sub in sub_iframes:
                try:
                    driver.switch_to.frame(sub)
                    inputs = driver.find_elements(By.TAG_NAME, 'input')
                    visible = [i for i in inputs if i.is_displayed()]
                    if visible:
                        print(f"✅ 嵌套 iframe 有 {len(visible)} 個可見 input")
                        return visible, True
                    driver.switch_to.parent_frame()
                except:
                    driver.switch_to.parent_frame()
            driver.switch_to.default_content()
        except Exception as e:
            print(f"⚠️ iframe[{idx}] 錯誤: {e}")
            driver.switch_to.default_content()

    # 3. 嘗試 JavaScript 搜尋（含 shadow DOM）
    count = driver.execute_script("""
        function findInputs(root) {
            var found = [];
            root.querySelectorAll('input').forEach(i => found.push(i));
            root.querySelectorAll('*').forEach(el => {
                if (el.shadowRoot) {
                    el.shadowRoot.querySelectorAll('input').forEach(i => found.push(i));
                }
            });
            return found.length;
        }
        return findInputs(document);
    """)
    print(f"🔍 JS 搜尋 input (含 shadow DOM): {count}")

    return [], False


def login_casino(driver):
    """登入娛樂城"""
    print(f"🌐 前往 {CASINO_URL}")
    driver.get(CASINO_URL)

    # SPA 需要等待 — 最多等 30 秒
    print("⏳ 等待頁面載入...")
    for wait in range(6):
        time.sleep(5)
        # 診斷頁面
        diag = driver.execute_script("""
            return {
                url: location.href,
                title: document.title,
                body: (document.body.innerText || '').substring(0, 200),
                inputs: document.querySelectorAll('input').length,
                iframes: document.querySelectorAll('iframe').length,
                divs: document.querySelectorAll('div').length
            };
        """)
        print(f"🔍 [{(wait+1)*5}s] inputs={diag['inputs']} iframes={diag['iframes']} divs={diag['divs']} title={diag['title']}")
        
        if diag['inputs'] > 0:
            break
        if 'login' in diag['body'].lower() or '登入' in diag['body'] or '帳號' in diag['body']:
            print("🔍 頁面有登入相關文字，繼續搜尋...")
            break

    # 搜尋所有 frame 中的 input
    inputs, in_iframe = find_inputs_in_all_frames(driver)
    print(f"🔍 最終找到 {len(inputs)} 個可見 input")

    if not inputs:
        # 最後嘗試：截圖看看頁面長什麼樣
        try:
            driver.save_screenshot('/tmp/mt_login_debug.png')
            print("📸 截圖已存: /tmp/mt_login_debug.png")
        except:
            pass
        # 輸出頁面 HTML 片段
        html = driver.execute_script("return document.body.innerHTML.substring(0, 1000)")
        print(f"📄 HTML: {html[:300]}")
        print(f"❌ 找不到帳密欄位")
        return False

    user_input = pass_input = None
    for inp in inputs:
        try:
            t = (inp.get_attribute('type') or '').lower()
            if t == 'password' and not pass_input:
                pass_input = inp
            elif t in ('text', 'tel', '') and not user_input and t != 'hidden':
                user_input = inp
        except:
            pass

    if not user_input or not pass_input:
        # 如果只有2個input，第一個=帳號 第二個=密碼
        if len(inputs) >= 2:
            user_input = inputs[0]
            pass_input = inputs[1]
            print("🔑 用前兩個 input 作為帳號/密碼")
        else:
            print(f"❌ 無法辨識帳密欄位 (找到 {len(inputs)} 個)")
            return False

    print("🔑 填入帳號密碼...")
    try:
        user_input.click()
        time.sleep(0.2)
        user_input.clear()
        user_input.send_keys(CASINO_USER)
        time.sleep(0.3)
        pass_input.click()
        time.sleep(0.2)
        pass_input.clear()
        pass_input.send_keys(CASINO_PASS)
        time.sleep(0.3)
    except Exception as e:
        print(f"⚠️ 填入失敗: {e}")
        # 用 JS 填入
        driver.execute_script("""
            arguments[0].value = arguments[2];
            arguments[0].dispatchEvent(new Event('input', {bubbles: true}));
            arguments[1].value = arguments[3];
            arguments[1].dispatchEvent(new Event('input', {bubbles: true}));
        """, user_input, pass_input, CASINO_USER, CASINO_PASS)
        print("🔑 用 JS 填入")

    time.sleep(0.5)

    # 找登入按鈕
    login_btn = None
    try:
        buttons = driver.find_elements(By.TAG_NAME, 'button')
        for btn in buttons:
            try:
                txt = btn.text.strip()
                if txt and any(w in txt for w in ['登入', '登錄', 'Login', '確定', '提交']):
                    login_btn = btn
                    break
            except:
                pass
        if not login_btn:
            subs = driver.find_elements(By.CSS_SELECTOR, 'button[type="submit"], input[type="submit"], [class*="login"], [class*="submit"]')
            if subs:
                login_btn = subs[0]
    except:
        pass

    if login_btn:
        login_btn.click()
        print(f"🖱️ 點擊登入")
    else:
        from selenium.webdriver.common.keys import Keys
        pass_input.send_keys(Keys.RETURN)
        print("⏎ Enter 登入")

    time.sleep(5)
    if in_iframe:
        driver.switch_to.default_content()

    print(f"✅ 登入後: {driver.current_url}")
    return True


def close_popups(driver):
    """關閉彈窗"""
    time.sleep(2)
    for sel in ['.close', '[class*="close"]', '.btn-close', '[aria-label="Close"]']:
        try:
            for btn in driver.find_elements(By.CSS_SELECTOR, sel):
                if btn.is_displayed():
                    btn.click()
                    time.sleep(0.5)
        except:
            pass


def enter_mt_game(driver):
    """進入 MT 真人百家樂"""
    # 點「真人視訊」或「真人」
    print("🎰 找真人視訊...")
    for text_to_find in ['真人視訊', '真人']:
        try:
            els = driver.find_elements(By.XPATH, f"//*[contains(text(), '{text_to_find}')]")
            for el in els:
                if el.is_displayed() and len(el.text.strip()) < 20:
                    el.click()
                    print(f"✅ 點: {el.text.strip()}")
                    time.sleep(3)
                    break
        except:
            pass

    # 點「MT真人」
    print("🎰 找 MT真人...")
    try:
        for el in driver.find_elements(By.XPATH, "//*[contains(text(), 'MT')]"):
            if el.is_displayed() and 'MT' in el.text and len(el.text) < 30:
                try:
                    parent = el.find_element(By.XPATH, '..')
                    imgs = parent.find_elements(By.TAG_NAME, 'img')
                    if imgs:
                        imgs[0].click()
                    else:
                        parent.click()
                except:
                    el.click()
                print(f"✅ 點 MT: {el.text.strip()}")
                time.sleep(5)
                return True
    except:
        pass

    # 備用
    try:
        for img in driver.find_elements(By.TAG_NAME, 'img'):
            src = img.get_attribute('src') or ''
            if 'mt' in src.lower():
                img.click()
                print(f"✅ 點 MT 圖: {src[:60]}")
                time.sleep(5)
                return True
    except:
        pass

    print("⚠️ 找不到 MT真人")
    return False


def switch_to_game_window(driver):
    """切換到遊戲視窗（MT 通常會開新視窗/iframe）"""
    handles = driver.window_handles
    if len(handles) > 1:
        driver.switch_to.window(handles[-1])
        print(f"� 切到新視窗: {driver.title} | {driver.current_url}")
        time.sleep(3)
        return True

    # 檢查 iframe
    iframes = driver.find_elements(By.TAG_NAME, 'iframe')
    for iframe in iframes:
        src = iframe.get_attribute('src') or ''
        if 'game' in src.lower() or 'mt' in src.lower() or 'rbjork' in src.lower():
            driver.switch_to.frame(iframe)
            print(f"🔀 切到 iframe: {src[:80]}")
            time.sleep(3)
            return True

    print("ℹ️ 維持當前視窗")
    return False


def scrape_tables(driver):
    """從 DOM 讀取所有百家樂桌資料"""
    try:
        tables = driver.execute_script(SCRAPE_TABLES_JS)
        return tables or []
    except Exception as e:
        print(f"⚠️ DOM 讀取失敗: {e}")
        return []


def send_to_node(data):
    """POST 資料給 Node.js"""
    try:
        resp = requests.post(f"{NODE_SERVER}/api/mt-data", json=data, timeout=5)
        return resp.status_code == 200
    except Exception as e:
        print(f"⚠️ POST 失敗: {e}")
        return False


def monitor_loop(driver):
    """主監控迴圈：定期讀取 DOM + 偵測新開牌"""
    print(f"🔄 開始監控 (每 {POLL_INTERVAL} 秒)")
    
    prev_tables = {}  # tableNum -> {banker, player, tie}
    cycle = 0
    
    while True:
        try:
            cycle += 1
            tables = scrape_tables(driver)
            
            if not tables:
                if cycle <= 3:
                    print(f"⏳ 第{cycle}次掃描，未找到牌桌...")
                    # 嘗試找「百家樂」分頁
                    try:
                        for el in driver.find_elements(By.XPATH, "//*[text()='百家樂']"):
                            if el.is_displayed():
                                el.click()
                                print("✅ 點「百家樂」分頁")
                                time.sleep(2)
                                break
                    except:
                        pass
                time.sleep(POLL_INTERVAL)
                continue
            
            # 偵測新開牌
            new_results = []
            for t in tables:
                num = t['tableNum']
                prev = prev_tables.get(num)
                if prev:
                    # 比較統計數字變化
                    new_total = t['banker'] + t['player'] + t['tie']
                    old_total = prev['banker'] + prev['player'] + prev['tie']
                    if new_total > old_total:
                        # 有新局！判斷誰贏
                        if t['banker'] > prev['banker']:
                            winner = 'B'
                        elif t['player'] > prev['player']:
                            winner = 'P'
                        else:
                            winner = 'T'
                        new_results.append({
                            'tableNum': num,
                            'winner': winner,
                            'banker': t['banker'],
                            'player': t['player'],
                            'tie': t['tie'],
                            'dealer': t.get('dealer', ''),
                        })
                        print(f"🃏 新開牌: 百家樂{num} → {'莊' if winner == 'B' else '閒' if winner == 'P' else '和'} "
                              f"(莊{t['banker']} 閒{t['player']} 和{t['tie']})")
                
                prev_tables[num] = {
                    'banker': t['banker'],
                    'player': t['player'],
                    'tie': t['tie'],
                }
            
            # 回傳牌桌列表（每次都傳，保持最新）
            formatted = []
            for t in tables:
                formatted.append({
                    'tableId': f"mt_{t['tableNum']}",
                    'tableNum': t['tableNum'],
                    'tableName': f"百家樂 {t['tableNum']}",
                    'dealer': t.get('dealer', ''),
                    'summary': {
                        'total': t['banker'] + t['player'] + t['tie'],
                        'banker': t['banker'],
                        'player': t['player'],
                        'tie': t['tie'],
                    },
                    'onlinePlayers': t.get('onlinePlayers', 0),
                    'roadText': t.get('roadText', ''),
                })
            
            send_to_node({'type': 'tables_update', 'tables': formatted})
            
            # 回傳新開牌
            for nr in new_results:
                send_to_node({
                    'type': 'game_result',
                    'tableId': f"mt_{nr['tableNum']}",
                    'tableNum': nr['tableNum'],
                    'winner': nr['winner'],
                    'summary': {
                        'total': nr['banker'] + nr['player'] + nr['tie'],
                        'banker': nr['banker'],
                        'player': nr['player'],
                        'tie': nr['tie'],
                    }
                })
            
            if cycle % 10 == 1:
                print(f"📋 掃描 #{cycle}: {len(tables)} 張桌 | "
                      f"{len(new_results)} 新開牌 | "
                      f"桌: {', '.join(t['tableNum'] for t in tables[:5])}...")
            
            time.sleep(POLL_INTERVAL)
            
        except KeyboardInterrupt:
            print("\n🛑 停止")
            break
        except StaleElementReferenceException:
            print("⚠️ 頁面更新中，重試...")
            time.sleep(2)
        except WebDriverException as e:
            print(f"⚠️ 瀏覽器錯誤: {e}")
            time.sleep(10)
        except Exception as e:
            print(f"⚠️ 錯誤: {e}")
            time.sleep(POLL_INTERVAL)


def main():
    if not CASINO_USER or not CASINO_PASS:
        print("❌ 請在 .env 設定 MT_CASINO_USERNAME 和 MT_CASINO_PASSWORD")
        sys.exit(1)

    print("═" * 50)
    print("🎰 MT Baccarat DOM 抓取器")
    print(f"📡 Node.js: {NODE_SERVER}")
    print(f"🌐 娛樂城: {CASINO_URL}")
    print(f"⏱️ 掃描間隔: {POLL_INTERVAL}秒")
    print("═" * 50)

    driver = None
    try:
        driver = create_driver()
        print("✅ Chrome 啟動")

        if not login_casino(driver):
            print("❌ 登入失敗，退出")
            return

        close_popups(driver)
        enter_mt_game(driver)

        print("⏳ 等待遊戲載入...")
        time.sleep(8)

        switch_to_game_window(driver)

        # 點「百家樂」分頁（如果有）
        try:
            for el in driver.find_elements(By.XPATH, "//*[text()='百家樂']"):
                if el.is_displayed():
                    el.click()
                    print("✅ 點「百家樂」分頁")
                    time.sleep(2)
                    break
        except:
            pass

        monitor_loop(driver)

    except KeyboardInterrupt:
        print("\n🛑 收到停止信號")
    except Exception as e:
        print(f"❌ 致命錯誤: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if driver:
            driver.quit()
            print("🔌 Chrome 已關閉")


if __name__ == '__main__':
    main()
