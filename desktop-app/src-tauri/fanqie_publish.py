#!/usr/bin/env python3
"""Publish one chapter through the user's local Fanqie creator session.

The browser profile is kept in the app data directory. The user completes
login once in the visible browser; no credentials are stored in the project.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def emit(status: str, message: str, **extra: object) -> None:
    print(json.dumps({"status": status, "message": message, **extra}, ensure_ascii=False), flush=True)


def visible(page, selectors: list[str]):
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if locator.is_visible(timeout=700):
                return locator
        except Exception:
            pass
    return None


def visible_button_with_text(page, labels: list[str]):
    """Find a rendered button by its exact/contained label.

    The confirmation dialog is rendered in a portal and its button can miss
    the normal CSS text selector during hydration, so inspect the live button
    nodes as a fallback.
    """
    try:
        buttons = page.locator("button, [role='button']")
        for index in range(buttons.count()):
            button = buttons.nth(index)
            if not button.is_visible(timeout=300):
                continue
            text = button.inner_text(timeout=500).strip()
            if any(text == label or label in text for label in labels):
                return button
    except Exception:
        pass
    return None


def browser_executable() -> str | None:
    """Prefer an installed Chromium browser over Playwright's cache.

    Playwright's browser cache can be removed by an update or cleanup tool,
    while the user's Chrome installation is normally stable and already has
    the expected system fonts and network configuration.
    """
    candidates = [
        Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        Path('/Applications/Chromium.app/Contents/MacOS/Chromium'),
        Path('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        Path('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
        Path.home() / 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        Path(r'C:/Program Files/Google/Chrome/Application/chrome.exe'),
        Path(r'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'),
    ]
    return next((str(path) for path in candidates if path.exists()), None)


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        emit("missing_runtime", "当前设备缺少 Python Playwright，请先安装 playwright 及浏览器运行时。", detail=str(exc))
        return 0
    try:
        payload = json.load(sys.stdin)
        title = str(payload.get("chapterTitle") or "").strip()
        content = str(payload.get("content") or "").strip()
        creator_url = str(payload.get("creatorURL") or "https://fanqienovel.com/author")
        # /main/writer is the retired reader route and now renders a 404-like
        # page. Keep old project settings working with the current author hub.
        creator_url = re.sub(r"/main/writer(?:/[^/?]*)?/?$", "/author", creator_url)
        book_id = str(payload.get("bookId") or "").strip()
        profile_value = str(payload.get("profileDir") or "").strip()
        profile = Path(profile_value) if profile_value else Path.home() / ".apisaverwriter" / "fanqie-browser"
        profile.mkdir(parents=True, exist_ok=True)
        if not title or not content:
            emit("error", "发布章节需要标题和正文。")
            return 0
        # The author hub is a client-rendered shell. Going straight to the
        # current new-chapter route avoids a timing-sensitive click and keeps
        # the selected book deterministic.
        chapter_number_match = re.search(r"(?:第\s*)?(\d+)", title)
        chapter_number = chapter_number_match.group(1) if chapter_number_match else ""
        clean_title = re.sub(r"^第\s*\d+\s*章[：:、.。\s]*", "", title).strip() or title
        if book_id:
            creator_url = f"https://fanqienovel.com/main/writer/{book_id}/publish/?enter_from=newchapter_0"
        elif "book_id=" not in creator_url:
            creator_url += ("&" if "?" in creator_url else "?") + f"book_id={book_id}" if book_id else ""
        with sync_playwright() as playwright:
            launch_options = {"headless": bool(payload.get("headless", True))}
            installed_browser = browser_executable()
            if installed_browser:
                launch_options["executable_path"] = installed_browser
            try:
                browser = playwright.chromium.launch_persistent_context(str(profile), **launch_options)
            except Exception as exc:
                detail = str(exc)
                if installed_browser:
                    emit("error", f"启动本机浏览器失败：{detail}", browser=installed_browser)
                    return 0
                emit("missing_runtime", "未找到可用浏览器。请安装 Google Chrome，或执行 playwright install chromium。", detail=detail)
                return 0
            try:
                page = browser.pages[0] if browser.pages else browser.new_page()
                publish_api_result: dict[str, object] = {}
                def capture_publish_response(response) -> None:
                    if "publish_article" not in response.url:
                        return
                    try:
                        payload = json.loads(response.text())
                        if isinstance(payload, dict):
                            publish_api_result.update(payload)
                    except Exception:
                        pass
                page.on("response", capture_publish_response)
                if book_id:
                    # Resolve an existing chapter from the management table.
                    # Creating a new article here was the source of the
                    # duplicate entries in 草稿箱.
                    manage_url = f"https://fanqienovel.com/main/writer/chapter-manage/{book_id}&type=2"
                    page.goto(manage_url, wait_until="domcontentloaded", timeout=30_000)
                    page.wait_for_timeout(8_000)
                    try:
                        draft_tab = page.get_by_text("草稿箱", exact=True)
                        if draft_tab.is_visible(timeout=700):
                            draft_tab.click()
                            page.wait_for_timeout(2_000)
                    except Exception:
                        pass
                    wanted = re.sub(r"\s+", "", f"第{chapter_number}章{clean_title}") if chapter_number else re.sub(r"\s+", "", title)
                    links = page.locator("a.font-1")
                    for index in range(links.count()):
                        link = links.nth(index)
                        if not link.is_visible(timeout=300):
                            continue
                        label = re.sub(r"\s+", "", link.inner_text(timeout=500))
                        if label == wanted or (chapter_number and label.startswith(f"第{chapter_number}章") and clean_title in label):
                            # Title and edit icon live in the same table row;
                            # draft rows use modifydraft while published rows
                            # use modifychapter.
                            row = link.locator("xpath=ancestor::*[self::tr or contains(@class,'arco-table-tr')][1]")
                            edit_link = row.locator("a[href*='modify']").first
                            href = edit_link.get_attribute("href") if edit_link.count() else None
                            if href:
                                creator_url = f"https://fanqienovel.com{href}" if href.startswith("/") else href
                                break
                page.goto(creator_url, wait_until="domcontentloaded", timeout=30_000)
                page.wait_for_timeout(10_000)
                login = page.get_by_text(re.compile(r"^(登录|扫码登录|登录/注册|立即登录)$"), exact=True).first
                try:
                    needs_login = "/login" in page.url.lower() or login.is_visible(timeout=800)
                except Exception:
                    needs_login = "/login" in page.url.lower()
                if needs_login:
                    if launch_options["headless"]:
                        emit("login_required", "番茄创作后台登录状态已失效，请先在番茄后台登录一次后再发布。", url=page.url)
                        return 0
                    for _ in range(120):
                        page.wait_for_timeout(1_500)
                        try:
                            if not login.is_visible(timeout=300):
                                break
                        except Exception:
                            break
                    else:
                        emit("login_required", "登录等待超时，请在已打开的番茄创作后台完成登录后重试。", url=page.url)
                        return 0
                # The first input is the numeric chapter field on the current
                # editor. It rejects Chinese numerals and must be filled before
                # the title/body fields are mounted.
                inputs = page.locator("input")
                sequence_input = inputs.nth(0) if inputs.count() else None
                title_input = visible(page, [
                    "input[placeholder='请输入标题']", "input[placeholder*='标题']",
                    "input[aria-label*='标题']", "input[name*='title' i]",
                ])
                body_input = visible(page, [".ProseMirror[contenteditable='true']", "[contenteditable='true']"])
                if title_input is None or body_input is None or sequence_input is None:
                    emit("manual_required", "已打开番茄创作后台，但当前页面结构需要手动确认。", url=page.url)
                    return 0
                if chapter_number:
                    sequence_input.fill(chapter_number)
                    page.wait_for_timeout(800)
                title_input.fill(clean_title)
                page.wait_for_timeout(1_000)
                # ProseMirror's fill() path only commits the first paragraph in
                # this editor. Insert text in moderate chunks through the real
                # input pipeline and refocus before each chunk.
                body_input.evaluate("el => el.focus()")
                page.keyboard.press("Meta+A")
                page.keyboard.press("Backspace")
                for offset in range(0, len(content), 240):
                    body_input.evaluate("el => el.focus()")
                    page.keyboard.insert_text(content[offset:offset + 240])
                    if offset and offset % 1200 == 0:
                        page.wait_for_timeout(150)
                page.wait_for_timeout(2_000)
                try:
                    current_length = len(body_input.inner_text(timeout=2_000).strip())
                except Exception:
                    current_length = 0
                if current_length < min(1000, len(content) // 2):
                    emit("error", f"正文注入未完成（当前 {current_length} 字），未提交发布。", url=page.url)
                    return 0
                draft = page.locator("button[data-apm-action='core_chain_long_story_save_draft']").first
                if draft.is_visible(timeout=700):
                    draft.click(force=True, no_wait_after=True)
                    page.wait_for_timeout(5_000)
                next_button = None
                try:
                    exact_next = page.locator("button[data-apm-action='core_chain_long_story_next_confirm']").first
                    if exact_next.is_visible(timeout=700):
                        next_button = exact_next
                except Exception:
                    next_button = visible(page, ["button:has-text('下一步')", "[role='button']:has-text('下一步')"])
                if next_button is not None:
                    for attempt in range(2):
                        try:
                            current_next = page.get_by_role("button", name="下一步", exact=True)
                            current_next.click(force=True, no_wait_after=True)
                        except Exception:
                            next_button.click(force=True, no_wait_after=True)
                        page.wait_for_timeout(1_500 if attempt == 0 else 8_000)
                        if page.get_by_text("提交", exact=True).count():
                            break
                publish_button = visible(page, [
                    "button:has-text('提交审核')", "button:has-text('发布章节')",
                    "[role='button']:has-text('提交审核')", "[role='button']:has-text('发布章节')",
                ])
                # Fanqie currently opens a typo confirmation dialog after the
                # second step. Its primary action is labelled simply `提交`.
                if publish_button is None:
                    publish_button = visible(page, ["button:has-text('提交')", "[role='button']:has-text('提交')"])
                if publish_button is None:
                    # The typo dialog is portal-rendered and can appear a few
                    # seconds after the editor step. Poll its primary action.
                    for _ in range(12):
                        try:
                            candidate = page.locator("button").filter(has_text=re.compile(r"^\s*提交\s*$")).last
                            if candidate.is_visible(timeout=500):
                                publish_button = candidate
                                break
                        except Exception:
                            pass
                        publish_button = visible_button_with_text(page, ["提交审核", "提交"])
                        if publish_button is not None:
                            break
                        try:
                            exact_submit = page.get_by_text("提交", exact=True).last
                            if exact_submit.is_visible(timeout=300):
                                publish_button = exact_submit
                                break
                        except Exception:
                            pass
                        page.wait_for_timeout(1_000)
                if publish_button is None:
                    emit("prepared", "章节内容已填入番茄创作后台，请检查后手动提交。", url=page.url, contentLength=current_length)
                    return 0
                # Submission can trigger a long-running navigation while the
                # review request is queued; do not let Playwright wait on it.
                publish_button.click(timeout=5_000, no_wait_after=True)
                page.wait_for_timeout(3_000)
                # A second confirmation is required after selecting the
                # platform content check. Use the unlimited basic check by
                # default so publishing does not consume the daily deep-check
                # quota.
                try:
                    basic_check = page.get_by_role("button", name="仅基础检测", exact=True)
                    if basic_check.is_visible(timeout=1_500):
                        basic_check.click(force=True, no_wait_after=True)
                        page.wait_for_timeout(3_000)
                except Exception:
                    pass
                # The publish-settings dialog requires an explicit AI-content
                # choice. Leaving it unset makes `确认发布` a no-op and keeps
                # the item in 草稿箱. Choose the conservative `否` option.
                try:
                    no_ai = page.get_by_text("否", exact=True).last
                    if no_ai.is_visible(timeout=1_000):
                        no_ai.click(force=True, no_wait_after=True)
                        page.wait_for_timeout(500)
                except Exception:
                    pass
                try:
                    confirm_publish = page.get_by_role("button", name="确认发布", exact=True)
                    if confirm_publish.is_visible(timeout=2_000):
                        confirm_publish.click(force=True, no_wait_after=True)
                        page.wait_for_timeout(4_000)
                except Exception:
                    pass
                if page.locator("[role='dialog']").count() and page.get_by_role("button", name="确认发布", exact=True).is_visible(timeout=500):
                    emit("prepared", "番茄仍要求确认发布设置，章节暂未提交。", url=page.url, contentLength=current_length)
                elif publish_api_result.get("code") not in (None, 0):
                    emit("error", f"番茄拒绝提交：{publish_api_result.get('message') or publish_api_result.get('code')}", url=page.url, contentLength=current_length)
                else:
                    emit("published", "章节已提交到番茄创作后台。", url=page.url, contentLength=current_length)
                return 0
            finally:
                # Closing a persistent context can fail when Chrome exits first;
                # never replace a successful publish result with that cleanup error.
                # Playwright tears down the persistent context with the
                # process. Avoid cross-thread cleanup: the sync API is bound
                # to its owning greenlet and closing from a helper thread can
                # leave noisy greenlet errors in the app log.
                pass
    except Exception as exc:
        emit("error", f"番茄发布失败：{exc}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
