#!/usr/bin/env python3
"""
MT Baccarat 資料抓取器
用 Selenium 登入娛樂城 → 進入 MT 遊戲 → 攔截 WebSocket 資料 → 回傳給 Node.js server
"""

import os
import sys
import json
import time
import re
import threading
import requests
from dotenv import load_dotenv
from seleniumwire import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

# ===== 設定 =====
CASINO_URL = os.getenv('MT_CASINO_URL', 'https://seofufan.seogrwin1688.com/')
CASINO_USER = os.getenv('MT_CASINO_USERNAME', '')
CASINO_PASS = os.getenv('MT_CASINO_PASSWORD', '')
NODE_SERVER = os.getenv('NODE_SERVER_URL', 'http://localhost:3000')
CHROME_PATH = os.getenv('CHROME_PATH', '')  # 留空自動偵測

# ===== WebSocket 資料收集器 =====
class WSDataCollector:
    def __init__(self, server_url):
        self.server_url = server_url
        self.tables = {}
        self.sent_rounds = {}  # tableId -> last round A
        self.msg_count = 0
    
    def process_ws_response(self, url, body):
        """處理攔截到的 WS response"""
        if not body:
            return
        
        # 嘗試解析 JSON
        data_str = body if isinstance(body, str) else body.decode('utf-8', errors='ignore')
        
        # SignalR 格式用 \x1e 分隔
        parts = data_str.split('\x1e') if '\x1e' in data_str else [data_str]
        
        for part in parts:
            part = part.strip()
            if not part or part == '{}':
                continue
            try:
                msg = json.loads(part)
                self._handle_message(msg, url)
            except json.JSONDecodeError:
                pass
    
    def _handle_message(self, msg, url):
        """處理單筆訊息"""
        self.msg_count += 1
        
        # doubledragon 格式: {D: {Summary: ...}, C: 301, SI: "gc023002"}
        if 'D' in msg and 'SI' in msg:
            self._handle_dd(msg)
            return
        
        # SignalR 格式
        if msg.get('type') == 1 and 'target' in msg:
            target = msg['target']
            if self.msg_count <= 10:
                print(f"📡 SignalR: {target}")
    
    def _handle_dd(self, msg):
        """處理 doubledragon 格式"""
        d = msg['D']
        table_id = msg['SI']
        table_num = msg.get('C', 0)
        
        if 'Summary' not in d:
            return
        
        summary = d['Summary']
        
        # 只收百家樂：必須有數字型 Banker 和 Player
        banker = summary.get('Banker')
        player = summary.get('Player')
        if not isinstance(banker, (int, float)) or not isinstance(player, (int, float)):
            return
        
        total = summary.get('Total', 0)
        tie = summary.get('Tie', 0)
        
        # 更新牌桌
        is_new = table_id not in self.tables
        self.tables[table_id] = {
            'tableId': table_id,
            'tableNum': table_num,
            'tableName': f'百家樂 {table_num}' if table_num else table_id,
            'summary': {
                'total': total,
                'banker': int(banker),
                'player': int(player),
                'tie': int(tie),
            },
            'lastUpdate': time.time()
        }
        
        if is_new:
            print(f"📋 新牌桌: 百家樂 {table_num} ({table_id}) 共{total}局 莊{int(banker)} 閒{int(player)} 和{int(tie)}")
        
        # 檢查新開牌
        game_list = d.get('List', [])
        if game_list and isinstance(game_list, list) and len(game_list) > 0:
            last_round = game_list[-1]
            last_a = last_round.get('A')
            prev_a = self.sent_rounds.get(table_id)
            
            if last_a and last_a != prev_a:
                self.sent_rounds[table_id] = last_a
                winner = last_round.get('G', '?')
                print(f"🃏 開牌: {table_id} 第{last_a}局 → {'莊' if winner == 'B' else '閒' if winner == 'P' else '和'}")
                
                # 回傳給 Node.js
                self._send_to_node('game_result', {
                    'tableId': table_id,
                    'tableNum': table_num,
                    'round': last_a,
                    'winner': winner,
                    'summary': self.tables[table_id]['summary']
                })
        
        # 定期回傳全部牌桌
        self._send_tables_update()
    
    def _send_tables_update(self):
        """回傳牌桌列表給 Node.js"""
        if not hasattr(self, '_last_tables_send') or time.time() - self._last_tables_send > 10:
            self._last_tables_send = time.time()
            try:
                resp = requests.post(
                    f"{self.server_url}/api/mt-data",
                    json={
                        'type': 'tables_update',
                        'tables': list(self.tables.values())
                    },
                    timeout=5
                )
                if resp.status_code == 200:
                    pass  # 靜默成功
                else:
                    print(f"⚠️ 回傳牌桌失敗: {resp.status_code}")
            except Exception as e:
                print(f"⚠️ 回傳失敗: {e}")
    
    def _send_to_node(self, event_type, data):
        """回傳事件給 Node.js"""
        try:
            resp = requests.post(
                f"{self.server_url}/api/mt-data",
                json={'type': event_type, **data},
                timeout=5
            )
        except Exception as e:
            print(f"⚠️ 回傳失敗: {e}")


# ===== 主程式 =====
def create_driver():
    """建立 Chrome driver"""
    chrome_options = Options()
    
    # 基本設定
    chrome_options.add_argument('--no-sandbox')
    chrome_options.add_argument('--disable-dev-shm-usage')
    chrome_options.add_argument('--disable-gpu')
    chrome_options.add_argument('--window-size=1280,800')
    chrome_options.add_argument('--disable-blink-features=AutomationControlled')
    chrome_options.add_experimental_option('excludeSwitches', ['enable-automation'])
    chrome_options.add_experimental_option('useAutomationExtension', False)
    
    # 在 Linux 無桌面環境用 headless
    if sys.platform == 'linux' and not os.environ.get('DISPLAY'):
        chrome_options.add_argument('--headless=new')
    
    if CHROME_PATH:
        chrome_options.binary_location = CHROME_PATH
    
    # selenium-wire 設定（攔截 WS）
    seleniumwire_options = {
        'enable_har': False,
        'ignore_http_methods': ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
    }
    
    driver = webdriver.Chrome(
        options=chrome_options,
        seleniumwire_options=seleniumwire_options
    )
    
    # 隱藏 webdriver 特徵
    driver.execute_cdp_cmd('Page.addScriptToEvaluateOnNewDocument', {
        'source': '''
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            delete navigator.__proto__.webdriver;
        '''
    })
    
    return driver


def login_casino(driver):
    """登入娛樂城"""
    print(f"🌐 前往 {CASINO_URL}")
    driver.get(CASINO_URL)
    time.sleep(5)
    
    print(f"🔍 頁面: {driver.title} | URL: {driver.current_url}")
    
    # 找帳號密碼欄位
    inputs = driver.find_elements(By.TAG_NAME, 'input')
    print(f"🔍 找到 {len(inputs)} 個 input 欄位")
    
    if len(inputs) == 0:
        # 檢查 iframe
        iframes = driver.find_elements(By.TAG_NAME, 'iframe')
        print(f"🔍 找到 {len(iframes)} 個 iframe")
        for iframe in iframes:
            try:
                driver.switch_to.frame(iframe)
                inputs = driver.find_elements(By.TAG_NAME, 'input')
                if len(inputs) > 0:
                    print(f"🔍 iframe 內找到 {len(inputs)} 個 input")
                    break
                driver.switch_to.default_content()
            except:
                driver.switch_to.default_content()
    
    # 等待更久
    if len(inputs) == 0:
        print("⏳ 等待頁面載入...")
        time.sleep(10)
        inputs = driver.find_elements(By.TAG_NAME, 'input')
    
    user_input = None
    pass_input = None
    
    for inp in inputs:
        inp_type = inp.get_attribute('type') or ''
        inp_name = inp.get_attribute('name') or ''
        inp_placeholder = inp.get_attribute('placeholder') or ''
        inp_id = inp.get_attribute('id') or ''
        
        if inp_type == 'password' and not pass_input:
            pass_input = inp
        elif inp_type in ('text', 'tel', '') and not user_input and inp_type != 'hidden':
            user_input = inp
    
    if not user_input or not pass_input:
        print(f"❌ 找不到帳密欄位 (inputs={len(inputs)})")
        # 嘗試用 CSS selector
        try:
            user_input = driver.find_element(By.CSS_SELECTOR, 'input[type="text"], input[type="tel"], input[name*="user"], input[name*="account"]')
            pass_input = driver.find_element(By.CSS_SELECTOR, 'input[type="password"]')
        except:
            print("❌ CSS selector 也找不到，放棄登入")
            return False
    
    print("🔑 填入帳號密碼...")
    user_input.clear()
    user_input.send_keys(CASINO_USER)
    time.sleep(0.5)
    pass_input.clear()
    pass_input.send_keys(CASINO_PASS)
    time.sleep(0.5)
    
    # 找登入按鈕
    buttons = driver.find_elements(By.TAG_NAME, 'button')
    login_btn = None
    for btn in buttons:
        text = btn.text.strip()
        if text in ('登入', '登錄', 'Login', '確定', '提交'):
            login_btn = btn
            break
    
    if not login_btn:
        # 嘗試 submit
        submit_btns = driver.find_elements(By.CSS_SELECTOR, 'button[type="submit"], input[type="submit"]')
        if submit_btns:
            login_btn = submit_btns[0]
    
    if login_btn:
        print(f"🖱️ 點擊登入按鈕: {login_btn.text}")
        login_btn.click()
    else:
        print("⚠️ 找不到登入按鈕，嘗試 Enter")
        pass_input.send_keys('\n')
    
    time.sleep(5)
    print(f"✅ 登入後: {driver.title} | URL: {driver.current_url}")
    return True


def close_popups(driver):
    """關閉彈窗"""
    time.sleep(3)
    try:
        # 常見關閉按鈕
        close_selectors = [
            '.close', '.modal-close', '[class*="close"]',
            'button.close', '.popup-close', '.btn-close',
            '[aria-label="Close"]', '.dialog-close'
        ]
        for sel in close_selectors:
            try:
                btns = driver.find_elements(By.CSS_SELECTOR, sel)
                for btn in btns:
                    if btn.is_displayed():
                        btn.click()
                        print(f"🔲 關閉彈窗: {sel}")
                        time.sleep(1)
            except:
                pass
    except:
        pass


def enter_mt_game(driver):
    """進入 MT 真人百家樂"""
    print("🎰 尋找真人視訊分類...")
    
    # 點「真人視訊」
    try:
        elements = driver.find_elements(By.XPATH, "//*[contains(text(), '真人視訊') or contains(text(), '真人')]")
        for el in elements:
            if el.is_displayed() and len(el.text.strip()) < 20:
                el.click()
                print(f"✅ 點擊: {el.text.strip()}")
                time.sleep(3)
                break
    except Exception as e:
        print(f"⚠️ 找不到真人視訊: {e}")
    
    # 點「MT真人」
    print("🎰 尋找 MT真人...")
    try:
        # 找 MT 文字
        mt_elements = driver.find_elements(By.XPATH, "//*[contains(text(), 'MT真人') or contains(text(), 'MT 真人')]")
        for el in mt_elements:
            if el.is_displayed():
                # 點擊父元素或圖片
                parent = el.find_element(By.XPATH, '..')
                try:
                    img = parent.find_element(By.TAG_NAME, 'img')
                    img.click()
                    print("✅ 點擊 MT真人 圖片")
                except:
                    parent.click()
                    print("✅ 點擊 MT真人 父元素")
                time.sleep(5)
                return True
        
        # 備用：找 MT 相關圖片
        imgs = driver.find_elements(By.TAG_NAME, 'img')
        for img in imgs:
            alt = img.get_attribute('alt') or ''
            src = img.get_attribute('src') or ''
            if 'mt' in alt.lower() or 'mt' in src.lower():
                img.click()
                print(f"✅ 點擊 MT 圖片: alt={alt}")
                time.sleep(5)
                return True
                
    except Exception as e:
        print(f"⚠️ 找不到 MT真人: {e}")
    
    return False


def monitor_ws(driver, collector):
    """持續監控 WebSocket 資料"""
    print("📡 開始監控 WebSocket...")
    
    # 用 CDP 監控 WS
    # selenium-wire 主要攔截 HTTP，WS 需要用 CDP
    
    # 取得 CDP session
    ws_data = {'connected': False}
    
    def ws_listener():
        """在背景執行 CDP WS 監控"""
        try:
            # 透過 Chrome DevTools Protocol 監控 WS
            driver.execute_cdp_cmd('Network.enable', {})
            print("✅ CDP Network 已啟用")
        except Exception as e:
            print(f"⚠️ CDP 啟用失敗: {e}")
    
    ws_listener()
    
    # 主迴圈：定期檢查頁面上的資料
    print("🔄 開始定期抓取頁面資料...")
    while True:
        try:
            # 方法1: 從頁面 DOM 直接讀取牌桌資料
            tables_data = driver.execute_script("""
                var tables = [];
                // 找所有百家樂桌的容器
                var cards = document.querySelectorAll('[class*="table"], [class*="game"], [class*="card"], [class*="room"]');
                cards.forEach(function(card) {
                    var text = card.innerText || '';
                    if (text.includes('百家樂') || text.includes('莊') || text.includes('閒')) {
                        // 提取統計數據
                        var match = text.match(/莊(\\d+).*?閒(\\d+).*?和(\\d+)/);
                        if (match) {
                            tables.push({
                                text: text.substring(0, 100),
                                banker: parseInt(match[1]),
                                player: parseInt(match[2]),
                                tie: parseInt(match[3])
                            });
                        }
                    }
                });
                return tables;
            """)
            
            if tables_data and len(tables_data) > 0:
                print(f"📋 DOM 抓到 {len(tables_data)} 張牌桌")
                # 回傳給 Node.js
                try:
                    requests.post(
                        f"{NODE_SERVER}/api/mt-data",
                        json={'type': 'dom_tables', 'tables': tables_data},
                        timeout=5
                    )
                except:
                    pass
            
            # 方法2: 攔截 selenium-wire 的請求
            for request in driver.requests:
                if request.response and ('doubledragon' in request.url or 'rbjork' in request.url):
                    if request.response.body:
                        collector.process_ws_response(request.url, request.response.body)
            
            # 清理已處理的請求
            del driver.requests
            
            time.sleep(5)
            
        except KeyboardInterrupt:
            print("\n🛑 停止監控")
            break
        except Exception as e:
            print(f"⚠️ 監控錯誤: {e}")
            time.sleep(10)


def main():
    if not CASINO_USER or not CASINO_PASS:
        print("❌ 請設定 MT_CASINO_USERNAME 和 MT_CASINO_PASSWORD")
        sys.exit(1)
    
    print("🎰 MT Baccarat Python 抓取器 啟動")
    print(f"📡 Node.js server: {NODE_SERVER}")
    print(f"🌐 娛樂城: {CASINO_URL}")
    
    collector = WSDataCollector(NODE_SERVER)
    driver = None
    
    try:
        driver = create_driver()
        print("✅ Chrome 已啟動")
        
        # 1. 登入
        if not login_casino(driver):
            print("❌ 登入失敗")
            return
        
        # 2. 關閉彈窗
        close_popups(driver)
        
        # 3. 進入 MT 遊戲
        enter_mt_game(driver)
        
        # 4. 等待遊戲載入
        print("⏳ 等待遊戲載入...")
        time.sleep(10)
        
        # 5. 檢查是否有新視窗
        handles = driver.window_handles
        if len(handles) > 1:
            driver.switch_to.window(handles[-1])
            print(f"🔀 切換到新視窗: {driver.title}")
        
        # 6. 開始監控
        monitor_ws(driver, collector)
        
    except KeyboardInterrupt:
        print("\n🛑 收到停止信號")
    except Exception as e:
        print(f"❌ 錯誤: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if driver:
            driver.quit()
            print("🔌 Chrome 已關閉")


if __name__ == '__main__':
    main()
