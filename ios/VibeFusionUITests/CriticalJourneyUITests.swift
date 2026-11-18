import XCTest

/// Critical journeys against a running backend. Server: env VF_TEST_SERVER (pass as TEST_RUNNER_VF_TEST_SERVER), default http://localhost:8080.
/// Skips when the server is unreachable so CI without a backend stays green.
final class CriticalJourneyUITests: XCTestCase {
    var server = ProcessInfo.processInfo.environment["VF_TEST_SERVER"] ?? "http://localhost:8080"

    override func setUpWithError() throws {
        continueAfterFailure = false
        let sem = DispatchSemaphore(value: 0)
        var up = false
        URLSession.shared.dataTask(with: URL(string: "\(server)/healthz")!) { _, r, _ in up = (r as? HTTPURLResponse)?.statusCode == 200; sem.signal() }.resume()
        _ = sem.wait(timeout: .now() + 3)
        try XCTSkipUnless(up, "Backend not running at \(server)")
    }

    private func launchSignedOutGuest() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["-vf.serverURL", server]
        app.launchEnvironment["VF_UITEST_RESET"] = "1"
        app.launch()
        if app.buttons["Get started"].waitForExistence(timeout: 5) { app.buttons["Get started"].tap() }
        if app.buttons["Continue as guest"].waitForExistence(timeout: 5) { app.buttons["Continue as guest"].tap() }
        if app.buttons["Skip"].waitForExistence(timeout: 5) { app.buttons["Skip"].tap() }
        if app.buttons["Not now"].waitForExistence(timeout: 5) { app.buttons["Not now"].tap() }
        if app.switches.firstMatch.waitForExistence(timeout: 5) {
            let toggle = app.switches.firstMatch
            toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
            app.buttons["Start listening"].tap()
        }
        return app
    }

    func testGuestNavigatesAllTabsAndStartsPlayback() throws {
        let app = launchSignedOutGuest()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 10))
        for tab in ["Discover", "AI Studio", "Podcasts", "Library", "Home"] {
            app.tabBars.buttons[tab].tap()
            XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 5), "\(tab) failed to load")
        }
        // Play the speech of the day: one tap from Home.
        let featured = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Speech of the day'")).firstMatch
        XCTAssertTrue(featured.waitForExistence(timeout: 10))
        featured.tap()
        let pause = app.buttons["Pause"].firstMatch
        XCTAssertTrue(pause.waitForExistence(timeout: 20), "Playback did not start")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.lifetime = .keepAlways
        add(shot)
    }

    func testStudioGeneratesAndPreviewsAPlan() throws {
        let app = launchSignedOutGuest()
        app.tabBars.buttons["AI Studio"].tap()
        let example = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Use example'")).firstMatch
        XCTAssertTrue(example.waitForExistence(timeout: 10))
        example.tap()
        app.buttons["Generate mix plan"].tap()
        XCTAssertTrue(app.navigationBars["Editor"].waitForExistence(timeout: 30), "Editor did not open")
        app.buttons["Preview mix"].tap()
        XCTAssertTrue(app.buttons["Pause preview"].waitForExistence(timeout: 90), "Preview did not start")
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.lifetime = .keepAlways
        add(shot)
    }
}
