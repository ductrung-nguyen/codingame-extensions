// Single-line comment at the top
#include <cmath>
#include <iostream>
#include <vector>

/* Multi-line comment
   explaining the distance calculation */
double calculateDistance(double x1, double y1, double x2, double y2) {
  // Calculate differences
  double dx = x2 - x1; // horizontal distance
  double dy = y2 - y1; // vertical distance

  /* Return the distance
     using Pythagorean theorem */
  return sqrt(dx * dx + dy * dy);
}

/**
 * GameBot class for managing bot behavior
 */
class GameBot {
private:
  // Private member variables
  double x, y;                                  // Current position
  std::vector<std::pair<double, double>> moves; // Movement history

public:
  // Constructor initializes the bot
  GameBot() : x(0), y(0) {
    // Starting at origin
  }

  /**
   * Move the bot to a new position
   * @param newX - X coordinate
   * @param newY - Y coordinate
   */
  void move(double newX, double newY) {
    // Update current position
    x = newX;
    y = newY;
    moves.push_back(std::make_pair(x, y)); // Track history
  }

  // Get the current strategy
  std::string getStrategy() {
    // TODO: Implement advanced strategy
    return "basic"; // Default strategy
  }

  /* Print the current position
     for debugging purposes */
  void printPosition() {
    std::cout << "Position: (" << x << ", " << y << ")"
              << std::endl; // Debug output
  }
};

// Main game loop
int main() {
  GameBot bot; // Create bot instance

  /* Process game state
     and execute moves */
  bot.move(5.0, 10.0);
  bot.printPosition(); // Show current position

  // End of main function
  return 0;
}
