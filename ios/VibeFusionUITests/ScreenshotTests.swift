import XCTest

/// Captures README screenshots as a guest (no personal data). Opt-in: runs only when VF_SCREENSHOTS=1
/// (pass as TEST_RUNNER_VF_SCREENSHOTS=1) and a backend is reachable at VF_TEST_SERVER.
final class ScreenshotTests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    lazy var server = env["VF_TEST_SERVER"] ?? "http://localhost:8080"

    override func setUpWithError() throws {
        try XCTSkipUnless(env["VF_SCREENSHOTS"] == "1", "Screenshots are opt-in")
        continueAfterFailure = true
    }

    private func snap(_ app: XCUIApplication, _ name: String) {
        sleep(3) // let artwork load
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    func testCaptureScreens() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-vf.serverURL", server]
        app.launchEnvironment["VF_UITEST_RESET"] = "1"
        app.launch()
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 10))
        snap(app, "01-welcome")
        app.buttons["Get started"].tap()
        app.buttons["Continue as guest"].tap()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 10))
        for chip in ["Cinematic", "Ambient", "Calm", "Uplifting", "Resilience"] where app.buttons[chip].exists { app.buttons[chip].tap() }
        snap(app, "02-interests")
        app.buttons["Continue"].tap()
        if app.buttons["Not now"].waitForExistence(timeout: 5) { app.buttons["Not now"].tap() }
        if app.switches.firstMatch.waitForExistence(timeout: 5) {
            app.switches.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
            app.buttons["Start listening"].tap()
        }
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 15))
        sleep(4)
        snap(app, "03-home")

        app.tabBars.buttons["Discover"].tap()
        sleep(3)
        snap(app, "04-discover")

        app.tabBars.buttons["Podcasts"].tap()
        sleep(3)
        snap(app, "05-podcasts")

        app.tabBars.buttons["Home"].tap()
        let featured = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Speech of the day'")).firstMatch
        if featured.waitForExistence(timeout: 10) {
            featured.tap()
            _ = app.buttons["Pause"].firstMatch.waitForExistence(timeout: 20)
            let mini = app.otherElements.matching(NSPredicate(format: "label BEGINSWITH 'Now playing'")).firstMatch
            if mini.exists { mini.tap() } else { app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '0'")).firstMatch.tap() }
            sleep(4)
            snap(app, "06-player")
            if app.buttons["Close player"].exists { app.buttons["Close player"].tap() } else { app.swipeDown() }
        }

        app.tabBars.buttons["AI Studio"].tap()
        let example = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Use example'")).firstMatch
        XCTAssertTrue(example.waitForExistence(timeout: 10))
        example.tap()
        snap(app, "07-studio")
        app.buttons["Generate mix plan"].tap()
        XCTAssertTrue(app.navigationBars["Editor"].waitForExistence(timeout: 30))
        sleep(2)
        snap(app, "08-editor")
        app.buttons["Preview mix"].tap()
        if app.buttons["Pause preview"].waitForExistence(timeout: 120) {
            sleep(6)
            snap(app, "09-fusion-preview")
        }

        app.tabBars.buttons["Home"].tap()
        if app.buttons["Motivation hub"].waitForExistence(timeout: 5) {
            app.buttons["Motivation hub"].tap()
            sleep(4)
            snap(app, "10-motivation")
        }
    }
}
